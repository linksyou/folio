import assert from "node:assert/strict";
import { test } from "node:test";
import { TranslationCache, MemoryTranslationCacheStore } from "../src/extension/translation-cache.js";
import { TranslationReuse } from "../src/extension/translation-reuse.js";
import { cacheDocumentUrl } from "../src/extension/cache-document-url.js";

test("batch cache hits do not wait for bookkeeping and hot reads avoid storage", async () => {
  const store = new MemoryTranslationCacheStore();
  const cache = new TranslationCache({ store });
  await cache.put([{key:'a',origin:'https://example.test',text:'译文'}, {key:'b',origin:'https://example.test',text:'另一段'}]);
  let reads=0;
  const get=store.get.bind(store);
  store.get=async key=>{reads++;return get(key);};
  const write=store.write.bind(store);
  store.write=async()=>{throw new Error('touch write must not run on a cache hit');};
  assert.equal((await cache.getMany(['a','b'])).size,2);
  assert.equal(await cache.get('a'),'译文');
  assert.equal(reads,2);
  store.write=write;
  await cache.clear('https://example.test');
  await cache.stats();
  assert.equal(await cache.get('a'),undefined,'deferred touches cannot restore a cleared entry');
});

test("hot entries respect expiry and serialized replacement/eviction", async () => {
  let now=1;
  const cache=new TranslationCache({store:new MemoryTranslationCacheStore(),now:()=>now,ttlMs:100,maxEntries:1});
  await cache.put([{key:'a',origin:'o',text:'old'}]);
  assert.equal(await cache.get('a'),'old');
  await cache.put([{key:'a',origin:'o',text:'new'}]);
  assert.equal(await cache.get('a'),'new');
  now=2;
  await cache.put([{key:'b',origin:'o',text:'other'}]);
  assert.equal(await cache.get('a'),undefined);
  now=102;
  assert.equal(await cache.get('b'),undefined);
});

test("document identity keeps routes and content queries while sharing confirmed anchors", () => {
  assert.equal(cacheDocumentUrl('https://example.test/doc?utm_source=x#intro',true),'https://example.test/doc');
  assert.equal(cacheDocumentUrl('https://example.test/doc#settings'),'https://example.test/doc#settings');
  assert.equal(cacheDocumentUrl('https://example.test/doc#/settings',true),'https://example.test/doc#/settings');
  assert.equal(cacheDocumentUrl('https://example.test/doc?lang=fr&utm_campaign=a'), 'https://example.test/doc?lang=fr');
});

test("reuse retains priority, rejects broken placeholders before caching, and deduplicates", async () => {
  let calls=0;
  const cache=new TranslationCache({store:new MemoryTranslationCacheStore()});
  const reuse=new TranslationReuse(cache,{
    async translate(request) {calls++;assert.equal(request.priority,'visible');return request.blocks.map(b=>({id:b.id,text:calls===1?'broken':'保留 ⟪FOLIO:0⟫'}));},cancel(){}
  });
  const req={jobId:'job',batchId:'one',origin:'https://example.test',url:'https://example.test/doc',settingsRevision:'r',priority:'visible' as const,blocks:[{id:'a',text:'Keep ⟪FOLIO:0⟫.'}]};
  await assert.rejects(reuse.translate(req), /受保护/);
  assert.equal((await cache.stats()).entries,0);
  assert.equal((await reuse.translate({...req,batchId:'two'}))[0].text,'保留 ⟪FOLIO:0⟫');
  await reuse.translate({...req,batchId:'three',url:req.url+'?utm_source=x#intro',anchorFragment:true});
  assert.equal(calls,2);
});

test("clearing while a request is running prevents a late cache refill", async () => {
  let finish!: (value: {id:string;text:string}[])=>void;
  let started!: ()=>void;
  const ready=new Promise<void>(resolve=>{started=resolve;});
  const cache=new TranslationCache({store:new MemoryTranslationCacheStore()});
  const reuse=new TranslationReuse(cache,{translate:request=>{started();return new Promise(resolve=>{finish=()=>resolve(request.blocks.map(b=>({id:b.id,text:'late'})));});},cancel(){}});
  const pending=reuse.translate({jobId:'j',batchId:'b',settingsRevision:'r',origin:'https://example.test',url:'https://example.test/',blocks:[{id:'a',text:'Original text'}]});
  await ready;await reuse.clear();finish([]);await pending;
  assert.equal((await cache.stats()).entries,0);
});
