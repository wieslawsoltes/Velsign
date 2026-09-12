import {readFile,readdir,stat} from 'node:fs/promises';import {resolve,dirname,join} from 'node:path';import {spawnSync} from 'node:child_process';
const root=resolve('dist-pages');const html=await readFile(join(root,'index.html'),'utf8');
for(const match of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g))await stat(resolve(root,match[1]));
if(!html.includes('pages-config.js'))throw Error('Pages config is missing.');
for(const file of await readdir(join(root,'js'))){if(!file.endsWith('.js'))continue;const path=join(root,'js',file),source=await readFile(path,'utf8');const check=spawnSync(process.execPath,['--check',path],{encoding:'utf8'});if(check.status)throw Error(check.stderr);for(const match of source.matchAll(/(?:from\s*|import\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g))await stat(resolve(dirname(path),match[1]));if(/from ['"]\/(?:vendor|js)\//.test(source))throw Error('Root-relative module in '+file);}
for(const path of ['samples/consulting.pdf','samples/nda.pdf','samples/offer.pdf','fonts/DejaVuSans.ttf','vendor/pdf.worker.mjs','vendor/pdf.mjs','vendor/fontkit.js','vendor/pdf-lib.js'])await stat(join(root,path));
console.log('Pages HTML, modules, sample PDFs, font, and worker assets validated for subpath hosting.');
