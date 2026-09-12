import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../public/js/paths.js',import.meta.url),'utf8');
async function at(url){return import('data:text/javascript;base64,'+Buffer.from(source.replaceAll('import.meta.url',JSON.stringify(url))).toString('base64'));}
await test('Pages assets resolve within repository subpath',async()=>{const paths=await at('https://wieslawsoltes.github.io/Velsign/js/paths.js');assert.equal(paths.assetURL('/vendor/pdf.worker.mjs'),'https://wieslawsoltes.github.io/Velsign/vendor/pdf.worker.mjs');assert.equal(paths.appURL('agreement/abc'),'https://wieslawsoltes.github.io/Velsign/#agreement/abc');});
await test('same modules preserve root-hosted backend URLs',async()=>{const paths=await at('https://velsign.example/js/paths.js');assert.equal(paths.assetURL('api/bootstrap'),'https://velsign.example/api/bootstrap');});
