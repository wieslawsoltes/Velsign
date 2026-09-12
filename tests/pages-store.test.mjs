import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {IDBFactory} from 'fake-indexeddb';
import {PDFDocument, degrees} from 'pdf-lib';
import {createPagesStore, PagesStore, LOCAL_USER, localMode} from '../public/js/pages-store.js';
import {digest, uid, verifyAudit} from '../public/js/core.js';

const sample = new Uint8Array(await readFile(new URL('../public/samples/consulting.pdf', import.meta.url)));
const sampleFetch = async url => {
  const file = new URL(url).pathname.split('/').at(-1);
  if (!['consulting.pdf', 'nda.pdf', 'offer.pdf'].includes(file)) return new Response('', {status:404});
  return new Response(await readFile(new URL(`../public/samples/${file}`, import.meta.url)));
};
function workspace(t, options = {}) {
  const factory = options.indexedDB || new IDBFactory();
  const store = createPagesStore({indexedDB:factory, baseURL:'https://example.github.io/Velsign/', fetch:sampleFetch, loadPDF:async () => ({PDFDocument}), ...options});
  t.after(() => store.close());
  return store;
}
const post = (store, path, body = {}) => store.request(path, {method:'POST', body});
const update = (store, document, action, payload = {}) => post(store, `envelopes/${document.id}/action`, {revision:document.revision, action, payload});
const status = (code, text) => error => error.status === code && (!text || text.test(error.message));
async function draft(store, {email = LOCAL_USER.email, count = 1, uploaded = false, title = 'Test agreement'} = {}) {
  const document = uploaded
    ? await store.request('files', {method:'POST', raw:sample, headers:{'X-Filename':'Service%20terms.pdf'}})
    : {builtin:'consulting', name:'Service terms.pdf'};
  let envelope = await post(store, 'envelopes', {title, documents:[document]});
  const recipients = Array.from({length:count}, (_, i) => ({id:uid(), name:`Local signer ${i + 1}`, email, role:'signer', order:i + 1}));
  const fields = recipients.map((recipient, i) => ({id:uid(), type:'signature', recipient:recipient.id, document:envelope.documents[0].id, page:0, x:.1, y:.55 + i * .1, w:.3, h:.05, required:true}));
  envelope = await update(store, envelope, 'edit', {recipients, fields});
  return envelope;
}
async function complete(store, envelope) {
  let result = await update(store, envelope, 'activate');
  for (const recipient of result.recipients) {
    const values = Object.fromEntries(result.fields.filter(field => field.recipient === recipient.id && field.type !== 'date').map(field => [field.id, 'Local signature']));
    result = await update(store, result, 'sign', {recipient:recipient.id, consent:true, values});
  }
  return result;
}

test('Pages edition exposes a fixed, explicitly unverified local identity', async t => {
  const store = workspace(t);
  assert.ok(store instanceof PagesStore);
  assert.equal(localMode, true);
  const bootstrap = await store.request('bootstrap');
  assert.equal(bootstrap.localMode, true);
  assert.equal(bootstrap.user.email, 'local@velsign.example');
  assert.equal(bootstrap.user.verified, false);
  assert.deepEqual(bootstrap.envelopes, []);
  assert.deepEqual(bootstrap.profile, {});
  await post(store, 'profile', {name:'Changed display name', email:'imposter@example.com', id:'imposter', verified:true, company:'Studio', signature:'Sample signature'});
  const updated = await store.request('bootstrap');
  assert.equal(updated.user.email, LOCAL_USER.email);
  assert.equal(updated.user.id, LOCAL_USER.id);
  assert.equal(updated.user.name, 'Changed display name');
  assert.equal(updated.user.verified, false);
  assert.equal(updated.profile.company, 'Studio');
  assert.equal(updated.profile.email, undefined);
});

test('uploaded PDFs persist their exact bytes, metadata, and original filename', async t => {
  const store = workspace(t);
  const padded = new Uint8Array(sample.length + 12);
  padded.set(sample, 6);
  const file = await store.request('files', {method:'POST', raw:padded.subarray(6, -6), headers:{'X-Filename':encodeURIComponent('Zażółć gęślą.pdf')}});
  assert.equal(file.name, 'Zażółć gęślą.pdf');
  assert.equal(file.digest, await digest(sample));
  assert.equal(file.size, sample.length);
  assert.deepEqual(file.pages, [{width:612, height:792}]);
  assert.equal(file.blob, undefined);
  const blob = await store.request(`files/${file.id}`);
  assert.equal(blob.type, 'application/pdf');
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), sample);
});

test('malformed, rotated, cropped, and active form PDFs are rejected', async t => {
  const store = workspace(t);
  const upload = raw => store.request('files', {method:'POST', raw});
  await assert.rejects(upload(new TextEncoder().encode('invalid PDF bytes')), status(400, /Upload a PDF/));
  await assert.rejects(upload(new TextEncoder().encode('%PDF-this is invalid')), status(400, /cannot be opened/));
  await assert.rejects(upload(new Uint8Array(10 * 1024 * 1024 + 1)), status(413));
  const rotated = await PDFDocument.create();
  rotated.addPage([612, 792]).setRotation(degrees(90));
  await assert.rejects(upload(await rotated.save()), status(400, /Rotate PDF/));
  const cropped = await PDFDocument.create();
  cropped.addPage([612, 792]).setCropBox(30, 40, 500, 650);
  await assert.rejects(upload(await cropped.save()), status(400, /cropped/));
  const form = await PDFDocument.create();
  form.getForm().createTextField('existing').addToPage(form.addPage());
  await assert.rejects(upload(await form.save()), status(400, /form fields/));
});

test('document records use stored metadata and disallow missing or duplicate uploads', async t => {
  const store = workspace(t);
  const file = await store.request('files', {method:'POST', raw:new Blob([sample])});
  const envelope = await post(store, 'envelopes', {title:'Safe metadata', documents:[{...file, digest:'forged', pages:[{width:1, height:1}]}], owner:'fake', status:'completed'});
  assert.equal(envelope.owner, LOCAL_USER.id);
  assert.equal(envelope.status, 'draft');
  assert.equal(envelope.documents[0].digest, file.digest);
  assert.deepEqual(envelope.documents[0].pages, file.pages);
  assert.equal(envelope.demo, false);
  assert.equal(envelope.localDemo, true);
  await assert.rejects(post(store, 'envelopes', {documents:[{id:uid()}]}), status(403));
  await assert.rejects(post(store, 'envelopes', {documents:[file, file]}), status(400, /twice/));
  const builtin = await post(store, 'envelopes', {documents:[{id:file.id, builtin:'nda'}]});
  assert.notEqual(builtin.documents[0].id, file.id);
  assert.match(builtin.documents[0].id, /^builtin:/);
  await assert.rejects(post(store, 'envelopes', {documents:[{builtin:'../../secrets'}]}), status(400));
});

test('sample documents use project-relative assets and their actual SHA-256 hashes', async t => {
  const store = workspace(t);
  const envelope = await post(store, 'envelopes', {documents:[{builtin:'consulting'}]});
  assert.equal(envelope.documents[0].digest, await digest(sample));
  assert.equal(await store.documentURL(envelope.documents[0], envelope.id), 'https://example.github.io/Velsign/samples/consulting.pdf');
  const before = envelope.documents[0].id;
  const edited = await update(store, envelope, 'edit', {documents:envelope.documents});
  assert.equal(edited.documents[0].id, before);
});

test('seeded agreements are practical self-signing examples with valid audit chains', async t => {
  const store = workspace(t);
  assert.deepEqual(await post(store, 'seed'), {ok:true});
  const bootstrap = await store.request('bootstrap');
  assert.equal(bootstrap.envelopes.length, 4);
  assert.equal(bootstrap.envelopes.filter(document => document.status === 'sent').length, 2);
  assert.ok(bootstrap.envelopes.every(document => document.recipients.every(recipient => recipient.email === LOCAL_USER.email)));
  assert.ok(bootstrap.envelopes.every(document => document.localDemo === true));
  const overview = bootstrap.envelopes.find(document => document.status === 'sent');
  assert.equal(overview.audit, undefined);
  assert.equal(overview.values, undefined);
  const envelope = await store.request(`envelopes/${overview.id}`);
  assert.equal(await verifyAudit(envelope.audit), true);
  const signature = envelope.fields.find(field => field.type === 'signature');
  const signed = await update(store, envelope, 'sign', {recipient:envelope.recipients[0].id, consent:true, values:{[signature.id]:'Local user'}});
  assert.equal(signed.status, 'completed');
  assert.equal(signed.values[envelope.fields.find(field => field.type === 'date').id], new Date().toISOString().slice(0, 10));
  await assert.rejects(post(store, 'seed'), status(409, /empty workspace/));
});

test('concurrent seed requests atomically create exactly one sample collection', async t => {
  const indexedDB = new IDBFactory();
  const first = workspace(t, {indexedDB});
  const second = workspace(t, {indexedDB});
  const results = await Promise.allSettled([post(first, 'seed'), post(second, 'seed')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal((await first.request('bootstrap')).envelopes.length, 4);
});

test('sequential signing enforces consent, required fields, activation lock, and ordering', async t => {
  const store = workspace(t);
  let envelope = await draft(store, {count:2});
  envelope = await update(store, envelope, 'activate');
  await assert.rejects(update(store, envelope, 'edit', {title:'Locked'}), status(409));
  await assert.rejects(update(store, envelope, 'sign', {recipient:envelope.recipients[0].id, consent:false}), status(400, /consent/));
  await assert.rejects(update(store, envelope, 'sign', {recipient:envelope.recipients[0].id, consent:true, values:{}}), status(400, /signature/));
  await assert.rejects(update(store, envelope, 'sign', {recipient:envelope.recipients[1].id, consent:true, values:{[envelope.fields[1].id]:'Second'}}), status(409, /next/));
  envelope = await update(store, envelope, 'sign', {recipient:envelope.recipients[0].id, consent:true, values:{[envelope.fields[0].id]:'First'}});
  assert.equal(envelope.status, 'sent');
  envelope = await update(store, envelope, 'sign', {recipient:envelope.recipients[1].id, consent:true, values:{[envelope.fields[1].id]:'Second'}});
  assert.equal(envelope.status, 'completed');
  assert.ok(envelope.completed);
  assert.equal(await verifyAudit(envelope.audit), true);
  await assert.rejects(update(store, envelope, 'void', {reason:'Too late'}), status(409));
  const record = await store.request(`envelopes/${envelope.id}/audit`);
  assert.equal(record.valid, true);
  assert.match(record.qualification, /No verified identity/);
});

test('signature PNG data is parsed before any signing state is committed', async t => {
  const store = workspace(t);
  const envelope = await update(store, await draft(store), 'activate');
  const invalid = 'data:image/png;base64,' + 'AAAA'.repeat(50);
  await assert.rejects(update(store, envelope, 'sign', {recipient:envelope.recipients[0].id, consent:true, values:{[envelope.fields[0].id]:invalid}}), status(400, /invalid/));
  const untouched = await store.request(`envelopes/${envelope.id}`);
  assert.equal(untouched.revision, envelope.revision);
  assert.equal(untouched.status, 'sent');
  assert.deepEqual(untouched.values, {});
});

test('independent connections preserve one authoritative revision during concurrent saves', async t => {
  const indexedDB = new IDBFactory();
  const first = workspace(t, {indexedDB});
  const second = workspace(t, {indexedDB});
  const envelope = await draft(first);
  const results = await Promise.allSettled([
    update(first, envelope, 'edit', {title:'From first tab'}),
    update(second, envelope, 'edit', {title:'From second tab'}),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const saved = await first.request(`envelopes/${envelope.id}`);
  assert.equal(saved.revision, envelope.revision + 1);
  assert.equal(saved.audit.length, envelope.audit.length + 1);
  assert.equal(await verifyAudit(saved.audit), true);
  const presence = await second.request(`envelopes/${envelope.id}/presence`, {method:'POST'});
  assert.equal(presence.revision, saved.revision);
  assert.equal(presence.people.length, 1);
  assert.equal(presence.people[0].name, LOCAL_USER.name);
  assert.equal(presence.localMode, true);
});

test('request arguments are snapshotted before queued storage mutations', async t => {
  const store = workspace(t);
  const envelope = await draft(store);
  const body = {revision:envelope.revision, action:'edit', payload:{title:'Submitted title'}};
  const result = store.request(`envelopes/${envelope.id}/action`, {method:'POST', body});
  body.payload.title = 'Changed after submission';
  assert.equal((await result).title, 'Submitted title');
});

test('a fresh adapter restores PDFs, agreements, comments, contacts, and profile data', async t => {
  const indexedDB = new IDBFactory();
  const first = workspace(t, {indexedDB});
  await post(first, 'profile', {name:'Local reviewer', company:'Studio'});
  const envelope = await draft(first, {uploaded:true});
  const comment = await post(first, `envelopes/${envelope.id}/comments`, {body:'Review the payment terms.'});
  await first.request(`envelopes/${envelope.id}/comments`, {method:'PATCH', body:{id:comment.id, resolved:true}});
  const contact = await post(first, 'contacts', {name:'Alex', email:'ALEX@example.com', company:'Example'});
  await first.close();
  const reopened = workspace(t, {indexedDB});
  const bootstrap = await reopened.request('bootstrap');
  assert.equal(bootstrap.profile.name, 'Local reviewer');
  assert.equal(bootstrap.envelopes.length, 1);
  assert.deepEqual(new Uint8Array(await (await reopened.request(`files/${envelope.documents[0].id}`)).arrayBuffer()), sample);
  const comments = await reopened.request(`envelopes/${envelope.id}/comments`);
  assert.equal(comments[0].resolved, 1);
  assert.equal(comments[0].name, 'Local reviewer');
  assert.equal((await reopened.request('contacts'))[0].email, 'alex@example.com');
  await reopened.request('contacts', {method:'DELETE', body:{id:contact.id}});
  assert.deepEqual(await reopened.request('contacts'), []);
});

test('template copies reset signatures and duplicate PDF storage atomically', async t => {
  const store = workspace(t);
  const completed = await complete(store, await draft(store, {uploaded:true}));
  const template = await post(store, `envelopes/${completed.id}/duplicate`, {kind:'template'});
  assert.equal(template.status, 'draft');
  assert.equal(template.kind, 'template');
  assert.equal(template.localDemo, true);
  assert.deepEqual(template.values, {});
  assert.equal(template.recipients[0].signedAt, undefined);
  assert.equal(template.recipients[0].signedBy, undefined);
  assert.notEqual(template.documents[0].id, completed.documents[0].id);
  assert.equal(template.fields[0].document, template.documents[0].id);
  const copiedFile = await store.request(`files/${template.documents[0].id}`);
  assert.deepEqual(new Uint8Array(await copiedFile.arrayBuffer()), sample);
  await assert.rejects(update(store, template, 'activate'), status(409));
  const agreement = await post(store, `envelopes/${template.id}/duplicate`);
  assert.equal(agreement.kind, 'agreement');
  assert.equal((await complete(store, agreement)).status, 'completed');
});

test('external recipients and collaboration report unsupported instead of granting fake access', async t => {
  const store = workspace(t);
  const envelope = await draft(store, {email:'someone@example.com'});
  await assert.rejects(update(store, envelope, 'activate'), status(501, /hosted server edition/));
  await assert.rejects(post(store, `envelopes/${envelope.id}/members`, {email:'someone@example.com', role:'editor'}), status(501));
  await assert.rejects(post(store, `envelopes/${envelope.id}/members`, {email:LOCAL_USER.email, role:'editor'}), status(409, /already owns/));
  await assert.rejects(post(store, `envelopes/${envelope.id}/links`, {recipient:envelope.recipients[0].id}), status(501));
  await assert.rejects(store.request(`sign/${envelope.id}/${envelope.recipients[0].id}`), status(501));
  assert.deepEqual(await store.request(`envelopes/${envelope.id}/members`), []);
  assert.equal((await store.request(`envelopes/${envelope.id}`)).status, 'draft');
});

test('local signing links retain the Pages base path and token rotation invalidates old links', async t => {
  const store = workspace(t);
  const envelope = await update(store, await draft(store), 'activate');
  const first = await post(store, `envelopes/${envelope.id}/links`, {recipient:envelope.recipients[0].id});
  const second = await post(store, `envelopes/${envelope.id}/links`, {recipient:envelope.recipients[0].id});
  assert.match(first.url, /^https:\/\/example\.github\.io\/Velsign\/#sign\//);
  assert.match(first.notice, /only in this browser profile/);
  assert.equal(first.envelope.recipients[0].tokenHash, undefined);
  const signURL = link => {
    const [route, id, recipient, token] = new URL(link).hash.slice(1).split('/');
    return `${route}/${id}/${recipient}?token=${token}`;
  };
  await assert.rejects(store.request(signURL(first.url)), status(403, /replaced/));
  const loaded = await store.request(signURL(second.url));
  assert.equal(loaded.signingRecipient, envelope.recipients[0].id);
  await assert.rejects(update(store, second.envelope, 'link', {recipient:envelope.recipients[0].id, tokenHash:'forged'}), status(400));
});

test('comments are scoped to an agreement and resolve/reopen changes persist', async t => {
  const store = workspace(t);
  const first = await draft(store);
  const second = await draft(store);
  const comment = await post(store, `envelopes/${first.id}/comments`, {body:'Review me'});
  await assert.rejects(store.request(`envelopes/${second.id}/comments`, {method:'PATCH', body:{id:comment.id, resolved:true}}), status(404));
  assert.deepEqual(await store.request(`envelopes/${second.id}/comments`), []);
  await store.request(`envelopes/${first.id}/comments`, {method:'PATCH', body:{id:comment.id, resolved:true}});
  assert.equal((await store.request(`envelopes/${first.id}/comments`))[0].resolved, 1);
  await store.request(`envelopes/${first.id}/comments`, {method:'PATCH', body:{id:comment.id, resolved:false}});
  assert.equal((await store.request(`envelopes/${first.id}/comments`))[0].resolved, 0);
});

test('document Blob URLs are reused, fetchable, and revoked with cleanup', async t => {
  const store = workspace(t);
  const envelope = await draft(store, {uploaded:true});
  const [first, second] = await Promise.all([store.documentURL(envelope.documents[0], envelope.id), store.documentURL(envelope.documents[0], envelope.id)]);
  assert.equal(first, second);
  assert.match(first, /^blob:/);
  assert.deepEqual(new Uint8Array(await (await fetch(first)).arrayBuffer()), sample);
  store.releaseDocumentURLs();
  await assert.rejects(fetch(first));
  const replacement = await store.documentURL(envelope.documents[0], envelope.id);
  assert.notEqual(replacement, first);
  await store.close();
  await assert.rejects(fetch(replacement));
  await assert.rejects(store.request('bootstrap'), status(503, /closed/));
});

test('invalid routes, storage availability, and malformed requests yield actionable status errors', async t => {
  const store = workspace(t);
  await assert.rejects(store.request('unknown'), status(404));
  await assert.rejects(store.request('envelopes/no-such-id'), status(404, /this browser/));
  await assert.rejects(store.request('contacts', {method:'PUT'}), status(405));
  await assert.rejects(store.request('profile', {method:'POST', body:'bad json'}), status(400));
  await assert.rejects(store.request('https://elsewhere.example/api/bootstrap'), status(400));
  assert.equal((await store.request('/api/bootstrap')).user.email, LOCAL_USER.email);
  assert.equal((await store.request('bootstrap?x=1')).user.email, LOCAL_USER.email);
  const unavailable = createPagesStore({indexedDB:null});
  await assert.rejects(unavailable.request('bootstrap'), status(503, /IndexedDB/));
});
