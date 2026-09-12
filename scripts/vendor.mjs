import {createRequire} from 'node:module';import {cp,mkdir} from 'node:fs/promises';
const require=createRequire(import.meta.url);const {build}=await import(require.resolve('esbuild',{paths:[require.resolve('drizzle-kit')]}));
await mkdir('public/vendor',{recursive:true});
await build({entryPoints:['node_modules/@pdf-lib/fontkit/dist/fontkit.es.js'],outfile:'public/vendor/fontkit.js',bundle:true,format:'esm',platform:'browser',minify:true});
for(const [src,dest] of [['pdfjs-dist/build/pdf.mjs','pdf.mjs'],['pdfjs-dist/build/pdf.worker.mjs','pdf.worker.mjs'],['pdf-lib/dist/pdf-lib.esm.min.js','pdf-lib.js'],['pdfjs-dist/cmaps','cmaps'],['pdfjs-dist/standard_fonts','standard_fonts'],['pdfjs-dist/wasm','wasm']])await cp('node_modules/'+src,'public/vendor/'+dest,{recursive:true});
