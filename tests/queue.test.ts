import assert from "node:assert/strict";
import { test } from "node:test";
import { RequestQueue } from "../src/host/queue.js";
import { validateCommand } from "../src/shared/validation.js";

test("visible work overtakes waiting background work, with bounded fairness", async () => {
  const queue=new RequestQueue(1);
  const signal=new AbortController().signal;
  let release!: ()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const first=queue.run(signal,()=>gate);
  const order:string[]=[];
  const background=queue.run(signal,async()=>{order.push('background');},'background');
  const visible=Array.from({length:12},(_,i)=>queue.run(signal,async()=>{order.push(`visible-${i}`);},'visible'));
  release();await Promise.all([first,background,...visible]);
  assert.equal(order[0],'visible-0');
  assert.equal(order.indexOf('background'),8);
  assert.equal(order.length,13);
});

test("cancelled waiting work never occupies a later slot", async () => {
  const queue=new RequestQueue(1);
  let release!:()=>void;
  const first=queue.run(new AbortController().signal,()=>new Promise<void>(r=>{release=r;}));
  await Promise.resolve();
  const controller=new AbortController();
  const cancelled=queue.run(controller.signal,async()=>{throw new Error('must not execute');},'visible');
  const rejected=assert.rejects(cancelled,/停止/);
  controller.abort();release();await first;await rejected;
  assert.equal(await queue.run(new AbortController().signal,async()=>42),42);
});

test("wire priority is optional for older clients and rejects arbitrary values", () => {
  const command={type:'translate',jobId:'j',settingsRevision:'r',blocks:[{id:'a',text:'hello'}]};
  assert.doesNotThrow(()=>validateCommand(command));
  assert.doesNotThrow(()=>validateCommand({...command,priority:'visible'}));
  assert.throws(()=>validateCommand({...command,priority:'urgent'}));
});
