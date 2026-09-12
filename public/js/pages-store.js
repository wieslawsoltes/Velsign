import {assert, audit, digest, emailValid, makeEnvelope, now, transition, uid, validateDocument, verifyAudit} from './core.js';

// This adapter is a single-device workspace, not an authentication or signing service.
// All tabs on this origin share its IndexedDB. A URL cannot transfer its data to a
// different browser, and this adapter never treats a display name as verified identity.
export const localMode = true;
export const LOCAL_USER = Object.freeze({id:'velsign-local-user', email:'local@velsign.example', name:'Local user', verified:false, localMode:true});
const STORES = ['envelopes', 'files', 'profiles', 'contacts', 'comments', 'members', 'presence'];
const SAMPLES = new Set(['consulting', 'nda', 'offer']);
const MAX_PDF = 10 * 1024 * 1024;
const LOCAL_ONLY = 'GitHub Pages stores this workspace only in this browser. External signing and collaboration require the hosted server edition.';
const clean = document => {
  const copy = structuredClone(document);
  copy.recipients.forEach(recipient => delete recipient.tokenHash);
  return copy;
};
const idbRequest = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function storageError(error) {
  if (error.status) return error;
  const wrapped = new Error(error.name === 'QuotaExceededError'
    ? 'Browser storage is full. Free device storage, then try saving again.'
    : 'Browser storage could not be opened or saved. Allow site storage and try again.');
  wrapped.status = 503;
  wrapped.cause = error;
  return wrapped;
}

export class PagesStore {
  constructor(options = {}) {
    this.localMode = true;
    this.name = options.name || 'velsign-pages-v1';
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.baseURL = new URL(options.baseURL || '../', import.meta.url);
    this.fetch = options.fetch || globalThis.fetch?.bind(globalThis);
    this.locks = options.locks ?? globalThis.navigator?.locks;
    this.loadPDF = options.loadPDF || (() => import('../vendor/pdf-lib.js'));
    this.objectURLs = new Map();
    this.sampleMetadata = new Map();
    this.pending = Promise.resolve();
    this.connection = null;
    this.closed = false;
  }

  async open() {
    assert(!this.closed, 'This workspace connection has been closed.', 503);
    assert(this.factory, 'This browser does not support durable IndexedDB storage.', 503);
    if (!this.connection) {
      this.connection = new Promise((resolve, reject) => {
        const request = this.factory.open(this.name, 1);
        request.onupgradeneeded = () => {
          for (const name of STORES) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, {keyPath:'id'});
          }
        };
        request.onerror = () => reject(storageError(request.error));
        request.onblocked = () => reject(Object.assign(new Error('Close other Velsign tabs so browser storage can be upgraded.'), {status:503}));
        request.onsuccess = () => {
          const database = request.result;
          if (this.closed) { database.close(); reject(Object.assign(new Error('This workspace connection has been closed.'), {status:503})); return; }
          database.onversionchange = () => { database.close(); this.connection = null; };
          resolve(database);
        };
      });
      this.connection.catch(() => { this.connection = null; });
    }
    return this.connection;
  }

  async transaction(names, mode, operation) {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      let tx;
      try { tx = database.transaction(names, mode); }
      catch (error) { reject(storageError(error)); return; }
      let result;
      let failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure || storageError(tx.error || new Error('Storage transaction aborted.')));
      tx.onerror = () => { /* onabort reports the original failure. */ };
      // Only await IndexedDB requests inside this callback. Crypto and PDF work
      // happens before opening the transaction so it cannot become inactive.
      Promise.resolve().then(() => operation(tx)).then(value => { result = value; }).catch(error => {
        failure = error.status ? error : storageError(error);
        try { tx.abort(); } catch { reject(failure); }
      });
    });
  }

  get(store, id) {
    return this.transaction([store], 'readonly', tx => idbRequest(tx.objectStore(store).get(id)));
  }

  all(store) {
    return this.transaction([store], 'readonly', tx => idbRequest(tx.objectStore(store).getAll()));
  }

  put(store, record) {
    return this.transaction([store], 'readwrite', tx => idbRequest(tx.objectStore(store).put(record)));
  }

  mutate(operation) {
    // Web Locks serialize preparation across browser tabs where available.
    // IndexedDB readwrite transactions plus revision CAS below also protect
    // concurrent saves in browsers without Web Locks.
    const execute = () => this.locks?.request
      ? this.locks.request(`velsign:${this.name}:write`, operation)
      : operation();
    const result = this.pending.then(execute, execute);
    this.pending = result.catch(() => {});
    return result;
  }

  async user() {
    const profile = await this.get('profiles', LOCAL_USER.id);
    return {...LOCAL_USER, name:profile?.name || LOCAL_USER.name};
  }

  async access(id) {
    const document = await this.get('envelopes', id);
    assert(document, 'Agreement not found in this browser. Signing links do not transfer local workspace data.', 404);
    assert(document.owner === LOCAL_USER.id, 'This local workspace cannot authenticate another owner.', 403);
    return {document, permission:'owner'};
  }

  async commit(before, after) {
    return this.transaction(['envelopes'], 'readwrite', async tx => {
      const store = tx.objectStore('envelopes');
      const current = await idbRequest(store.get(before.id));
      assert(current?.revision === before.revision, 'Another tab updated this agreement. Reload the latest version before saving.', 409);
      await idbRequest(store.put(after));
      return after;
    });
  }

  async sample(key) {
    assert(SAMPLES.has(key), 'Invalid sample document.');
    if (!this.sampleMetadata.has(key)) {
      const loading = (async () => {
        assert(this.fetch, 'Sample documents are unavailable in this browser.', 503);
        const response = await this.fetch(new URL(`samples/${key}.pdf`, this.baseURL).href);
        assert(response.ok, 'The sample document could not be loaded.', 503);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const {PDFDocument} = await this.loadPDF();
        const pdf = await PDFDocument.load(bytes, {updateMetadata:false});
        return {digest:await digest(bytes), pages:pdf.getPages().map(page => ({width:page.getWidth(), height:page.getHeight()}))};
      })();
      this.sampleMetadata.set(key, loading);
      loading.catch(() => this.sampleMetadata.delete(key));
    }
    return this.sampleMetadata.get(key);
  }

  async checkDocuments(documents, current = []) {
    assert(Array.isArray(documents) && documents.length <= 20, 'Invalid documents.');
    const checked = [];
    const ids = new Set();
    for (const document of documents) {
      assert(document && typeof document === 'object', 'Invalid document.');
      let result;
      if (document.builtin) {
        const metadata = await this.sample(document.builtin);
        result = {
          id:current.find(item => item.builtin === document.builtin && item.id === document.id)?.id || `builtin:${uid()}`,
          builtin:document.builtin,
          name:String(document.name || 'Sample agreement.pdf').slice(0, 200),
          ...metadata,
        };
      } else {
        assert(typeof document.id === 'string', 'Document unavailable.', 403);
        const file = await this.get('files', document.id);
        assert(file?.owner === LOCAL_USER.id, 'Document unavailable in this browser.', 403);
        const {id, name, pages, digest:hash, size} = file;
        result = {id, name, pages, digest:hash, size};
      }
      assert(!ids.has(result.id), 'The same document cannot be attached twice.');
      ids.add(result.id);
      checked.push(result);
    }
    return checked;
  }

  async upload(raw, headers) {
    let bytes;
    if (raw instanceof Blob) bytes = new Uint8Array(await raw.arrayBuffer());
    else if (raw instanceof ArrayBuffer) bytes = new Uint8Array(raw);
    else if (ArrayBuffer.isView(raw)) bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    else assert(false, 'Upload a PDF document.');
    assert(bytes.length <= MAX_PDF && bytes.length >= 8, 'PDF must be under 10 MB.', 413);
    assert(new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-', 'Upload a PDF document.');
    const {PDFDocument} = await this.loadPDF();
    let pdf;
    try { pdf = await PDFDocument.load(bytes, {updateMetadata:false}); }
    catch { assert(false, 'This PDF is encrypted or cannot be opened.'); }
    assert(pdf.getPageCount() > 0 && pdf.getPageCount() <= 100, 'Each PDF must contain between 1 and 100 pages.');
    assert(pdf.getPages().every(page => page.getRotation().angle % 360 === 0), 'Rotate PDF pages to 0° before uploading.');
    assert(pdf.getPages().every(page => {
      const crop = page.getCropBox(), media = page.getMediaBox();
      return media.x === 0 && media.y === 0 && crop.x === 0 && crop.y === 0 && Math.abs(crop.width - media.width) < .01 && Math.abs(crop.height - media.height) < .01;
    }), 'Flatten or normalize cropped PDF pages before uploading.');
    assert(pdf.getForm().getFields().length === 0, 'Flatten existing PDF form fields before uploading.');
    let filename = new Headers(headers).get('x-filename') || 'Document.pdf';
    try { filename = decodeURIComponent(filename); } catch { assert(false, 'Invalid document filename.'); }
    const file = {
      id:uid(), owner:LOCAL_USER.id, name:filename.slice(0, 200), digest:await digest(bytes),
      pages:pdf.getPages().map(page => ({width:page.getWidth(), height:page.getHeight()})),
      size:bytes.byteLength, blob:new Blob([bytes], {type:'application/pdf'}),
    };
    await this.put('files', file);
    const {owner, blob, ...metadata} = file;
    return metadata;
  }

  async validateSignatures(values) {
    for (const value of Object.values(values || {})) {
      if (typeof value !== 'string' || !value.startsWith('data:image/png;base64,')) continue;
      try {
        assert(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value), 'Invalid signature image.');
        assert(value.length <= 500000, 'Signature image too large.');
        const {PDFDocument} = await this.loadPDF();
        const pdf = await PDFDocument.create();
        const image = await pdf.embedPng(value);
        assert(image.width <= 4096 && image.height <= 4096, 'Signature image too large.');
      } catch { assert(false, 'Signature image is invalid. Please draw or type it again.'); }
    }
  }

  async seed(user) {
    const examples = [
      ['Website redesign agreement', 'consulting', true],
      ['Mutual non-disclosure agreement', 'nda', false],
      ['Employment offer · Product designer', 'offer', false],
      ['Consulting services agreement', 'consulting', true],
    ];
    const documents = [];
    for (const [title, builtin, activate] of examples) {
      const [file] = await this.checkDocuments([{builtin, name:`${title}.pdf`}]);
      const recipient = {id:uid(), name:user.name, email:user.email, role:'signer', order:1};
      let document = makeEnvelope({title, owner:user.id, ownerEmail:user.email, documents:[file], recipients:[recipient], demo:true});
      document.localDemo = true;
      document.fields = [
        {id:uid(), type:'signature', recipient:recipient.id, document:file.id, page:0, x:.12, y:.765, w:.3, h:.05, required:true},
        {id:uid(), type:'date', recipient:recipient.id, document:file.id, page:0, x:.6, y:.765, w:.22, h:.04, required:true},
      ];
      validateDocument(document);
      await audit(document, user.email, 'Created', 'Local sample agreement; browser-only identity is not verified.');
      if (activate) document = await transition(document, 'activate', {}, {...user, permission:'owner'});
      documents.push(document);
    }
    await this.transaction(['envelopes'], 'readwrite', async tx => {
      const store = tx.objectStore('envelopes');
      assert(await idbRequest(store.count()) === 0, 'Sample agreements are only available in an empty workspace.', 409);
      for (const document of documents) await idbRequest(store.add(document));
    });
    return {ok:true};
  }

  async duplicate(original, body, user) {
    const copy = makeEnvelope({
      title:String(body.title || original.title + (body.kind === 'template' ? ' template' : ' (copy)')).slice(0, 200),
      owner:user.id, ownerEmail:user.email, documents:[], kind:body.kind === 'template' ? 'template' : 'agreement',
    });
    copy.localDemo = true;
    const copiedFiles = [];
    for (const document of original.documents) {
      if (document.builtin) { copy.documents.push({...document, id:`builtin:${uid()}`}); continue; }
      const file = await this.get('files', document.id);
      assert(file?.owner === user.id && file.blob, 'Source document unavailable.', 404);
      const id = uid();
      copiedFiles.push({...file, id});
      copy.documents.push({...document, id});
    }
    copy.recipients = original.recipients.map(({tokenHash, status, signedAt, signedBy, ...recipient}) => recipient);
    copy.fields = original.fields.map(field => ({...field, document:copy.documents[original.documents.findIndex(document => document.id === field.document)]?.id}));
    copy.message = original.message;
    copy.sequential = original.sequential;
    validateDocument(copy);
    await audit(copy, user.email, 'Created', `Local copy of ${original.id}; browser-only identity is not verified.`);
    await this.transaction(['envelopes', 'files'], 'readwrite', async tx => {
      const store = tx.objectStore('envelopes');
      const latest = await idbRequest(store.get(original.id));
      assert(latest?.revision === original.revision, 'Another tab updated this agreement. Reload before copying.', 409);
      for (const file of copiedFiles) await idbRequest(tx.objectStore('files').add(file));
      await idbRequest(store.add(copy));
    });
    return {...clean(copy), permission:'owner'};
  }

  async request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    assert(['GET', 'POST', 'PATCH', 'DELETE'].includes(method), 'Method not supported.', 405);
    let body = options.body ?? {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { assert(false, 'Invalid JSON.'); }
    }
    assert(body && typeof body === 'object' && !Array.isArray(body), 'Invalid request body.');
    assert(JSON.stringify(body).length <= 2000000, 'Request too large.', 413);
    // Snapshot input before queueing so an editor cannot mutate an in-flight save.
    body = structuredClone(body);
    const url = new URL(String(path).replace(/^\/?api\//, '').replace(/^\//, ''), new URL('api/', this.baseURL));
    const prefix = new URL('api/', this.baseURL).pathname;
    assert(url.origin === this.baseURL.origin && url.pathname.startsWith(prefix), 'Invalid local API route.');
    const parts = url.pathname.slice(prefix.length).split('/').filter(Boolean).map(decodeURIComponent);
    const execute = () => this.route(parts, url, method, body, options);
    try { return await (method === 'GET' ? execute() : this.mutate(execute)); }
    catch (error) {
      if (error.status) throw error;
      throw storageError(error);
    }
  }

  async route(parts, url, method, body, options) {
    const [resource, id, action] = parts;
    assert(parts.length <= 3, 'Route not found.', 404);
    const user = await this.user();
    if (resource === 'bootstrap' && !id && method === 'GET') {
      const [documents, profile] = await Promise.all([this.all('envelopes'), this.get('profiles', user.id)]);
      return {
        user, profile:profile ? (({id, ...data}) => data)(profile) : {}, localMode:true,
        envelopes:documents.filter(document => document.owner === user.id).sort((a, b) => b.updated.localeCompare(a.updated)).map(document => {
          const copy = clean(document);
          delete copy.values; delete copy.audit;
          return copy;
        }),
      };
    }
    if (resource === 'profile' && !id && method === 'POST') {
      const safe = {name:String(body.name || user.name).slice(0, 150), company:String(body.company || '').slice(0, 150), signature:String(body.signature || '').slice(0, 150)};
      await this.put('profiles', {id:user.id, ...safe});
      return safe;
    }
    if (resource === 'seed' && !id && method === 'POST') return this.seed(user);
    if (resource === 'files' && !id && method === 'POST') return this.upload(options.raw, options.headers);
    if (resource === 'files' && id && !action && method === 'GET') {
      const file = await this.get('files', id);
      assert(file?.owner === user.id && file.blob, 'File not found in this browser.', 404);
      return file.blob;
    }
    if (resource === 'envelopes' && !id && method === 'POST') {
      const documents = await this.checkDocuments(body.documents || []);
      const document = makeEnvelope({title:String(body.title || 'Untitled agreement').slice(0, 200), owner:user.id, ownerEmail:user.email, documents, kind:body.kind === 'template' ? 'template' : 'agreement'});
      document.localDemo = true;
      validateDocument(document);
      await audit(document, user.email, 'Created', 'Local workspace; browser-only identity is not verified.');
      await this.transaction(['envelopes'], 'readwrite', tx => idbRequest(tx.objectStore('envelopes').add(document)));
      return clean(document);
    }
    if (resource === 'envelopes' && id) {
      const {document, permission} = await this.access(id);
      const actor = {...user, permission};
      if (!action && method === 'GET') return {...clean(document), permission};
      if (action === 'action' && method === 'POST') {
        assert(body.revision === document.revision, 'The agreement changed. Reload before saving.', 409);
        const payload = structuredClone(body.payload || {});
        assert(payload && typeof payload === 'object' && !Array.isArray(payload), 'Invalid action payload.');
        if (body.action === 'edit' && payload.documents) payload.documents = await this.checkDocuments(payload.documents, document.documents);
        if (body.action === 'activate') assert(document.recipients.every(recipient => recipient.email.toLowerCase() === user.email), LOCAL_ONLY, 501);
        if (body.action === 'sign' || body.action === 'decline') {
          const recipient = document.recipients.find(item => item.id === payload.recipient);
          assert(!recipient || recipient.email.toLowerCase() === user.email, LOCAL_ONLY, 501);
        }
        // Tokens can only be created through /links, which enforces local scope.
        assert(body.action !== 'link', 'Use the local signing link action.', 400);
        if (body.action === 'sign') await this.validateSignatures(payload.values);
        const after = await transition(document, body.action, payload, actor);
        await this.commit(document, after);
        return {...clean(after), permission};
      }
      if (action === 'duplicate' && method === 'POST') return this.duplicate(document, body, user);
      if (action === 'links' && method === 'POST') {
        const recipient = document.recipients.find(item => item.id === body.recipient);
        assert(recipient, 'Recipient not found.', 404);
        assert(recipient.email.toLowerCase() === user.email, LOCAL_ONLY, 501);
        const token = uid().replaceAll('-', '') + uid().replaceAll('-', '');
        const after = await transition(document, 'link', {recipient:body.recipient, tokenHash:await digest(token)}, actor);
        await this.commit(document, after);
        const link = new URL(this.baseURL);
        link.hash = `sign/${document.id}/${body.recipient}/${token}`;
        return {url:link.href, envelope:{...clean(after), permission}, localMode:true, notice:'This link works only in this browser profile. It does not share the agreement with another person.'};
      }
      if (action === 'audit' && method === 'GET') return {
        envelope:document.id, valid:await verifyAudit(document.audit), events:document.audit,
        documents:document.documents.map(item => ({name:item.name, sha256:item.digest})),
        qualification:'Local browser SHA-256 activity chain. No verified identity, external timestamp, PKI certificate, or server authority.',
      };
      if (action === 'members') {
        if (method === 'GET') return (await this.all('members')).filter(member => member.envelope === id);
        assert(method === 'POST' || method === 'DELETE', 'Method not supported.', 405);
        assert(emailValid(body.email), 'Enter a valid email.');
        assert(body.email.toLowerCase() === user.email, LOCAL_ONLY, 501);
        assert(false, 'The local workspace user already owns this agreement. Additional identities require the hosted server edition.', 409);
      }
      if (action === 'comments') {
        if (method === 'GET') return (await this.all('comments')).filter(comment => comment.envelope === id).sort((a, b) => a.created.localeCompare(b.created));
        if (method === 'PATCH') {
          await this.transaction(['comments'], 'readwrite', async tx => {
            const store = tx.objectStore('comments');
            const comment = await idbRequest(store.get(body.id));
            assert(comment?.envelope === id, 'Comment not found.', 404);
            comment.resolved = body.resolved ? 1 : 0;
            await idbRequest(store.put(comment));
          });
          return {ok:true};
        }
        assert(method === 'POST', 'Method not supported.', 405);
        assert(typeof body.body === 'string' && body.body.trim() && body.body.length <= 4000, 'Comment must be between 1 and 4,000 characters.');
        const comment = {id:uid(), envelope:id, author:user.id, name:user.name, body:body.body, created:now(), resolved:0};
        await this.put('comments', comment);
        return comment;
      }
      if (action === 'presence' && ['GET', 'POST'].includes(method)) {
        // Show the single local identity, never simulated external collaborators.
        const person = {id:`${id}:${user.id}`, envelope:id, name:user.name, seen:Date.now()};
        if (method === 'POST') await this.put('presence', person);
        const fresh = (await this.access(id)).document;
        return {revision:fresh.revision, people:[{name:user.name, seen:person.seen}], localMode:true};
      }
    }
    if (resource === 'sign' && id && action && method === 'GET') {
      const {document, permission} = await this.access(id);
      const recipient = document.recipients.find(item => item.id === action);
      assert(recipient, 'Recipient not found.', 404);
      assert(recipient.email.toLowerCase() === user.email, LOCAL_ONLY, 501);
      if (url.searchParams.has('token')) assert(await digest(url.searchParams.get('token')) === recipient.tokenHash, 'Signing link is invalid or was replaced.', 403);
      return {...clean(document), permission, signingRecipient:recipient.id};
    }
    if (resource === 'contacts' && !id) {
      if (method === 'GET') return (await this.all('contacts')).filter(contact => contact.owner === user.id).sort((a, b) => a.name.localeCompare(b.name));
      if (method === 'DELETE') {
        assert(typeof body.id === 'string', 'Choose a contact.');
        await this.transaction(['contacts'], 'readwrite', async tx => {
          const store = tx.objectStore('contacts');
          const contact = await idbRequest(store.get(body.id));
          if (contact?.owner === user.id) await idbRequest(store.delete(body.id));
        });
        return {ok:true};
      }
      assert(method === 'POST', 'Method not supported.', 405);
      assert(emailValid(body.email) && typeof body.name === 'string' && body.name.trim() && body.name.length < 150, 'Provide a name and valid email.');
      const contact = {id:uid(), owner:user.id, name:body.name, email:body.email.toLowerCase(), company:String(body.company || '').slice(0, 150)};
      await this.put('contacts', contact);
      return contact;
    }
    assert(false, 'Route not found.', 404);
  }

  async documentURL(document, envelope) {
    if (document.builtin) {
      assert(SAMPLES.has(document.builtin), 'Invalid sample document.');
      return new URL(`samples/${document.builtin}.pdf`, this.baseURL).href;
    }
    if (envelope) {
      const {document:agreement} = await this.access(typeof envelope === 'string' ? envelope : envelope.id);
      assert(agreement.documents.some(item => !item.builtin && item.id === document.id), 'Document is not attached to this agreement.', 403);
    }
    if (!this.objectURLs.has(document.id)) {
      const file = await this.get('files', document.id);
      assert(file?.owner === LOCAL_USER.id && file.blob, 'Document unavailable in this browser.', 404);
      // Another concurrent load may have populated the cache while IndexedDB ran.
      if (!this.objectURLs.has(document.id)) this.objectURLs.set(document.id, URL.createObjectURL(file.blob));
    }
    return this.objectURLs.get(document.id);
  }

  releaseDocumentURLs() {
    for (const url of this.objectURLs.values()) URL.revokeObjectURL(url);
    this.objectURLs.clear();
  }

  async close() {
    await this.pending;
    this.closed = true;
    this.releaseDocumentURLs();
    if (this.connection) (await this.connection).close();
    this.connection = null;
  }
}

export const createPagesStore = options => new PagesStore(options);
