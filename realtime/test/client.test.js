'use strict';
// Contract tests for WebSocket-first realtime with HTTP fallback during outages.
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../../src/assets/js/common.js'), 'utf8');
let failures = 0;
const warningMessages = [];
const assert = (condition, message) => { console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`); if (!condition) failures++; };
let now = 1_000_000, nextTimerId = 1;
const timers = new Map(), sockets = [], seenEvents = [];
class FakeWS {
  static OPEN = 1; static CLOSING = 2;
  constructor(url) { this.url=url; this.readyState=0; this.sent=[]; sockets.push(this); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close(code=1000, reason='') { this.readyState=3; if (this.onclose) this.onclose({code,reason}); }
}
const el={textContent:''};
const ctx={
 console:{log(){},warn(...a){warningMessages.push(a);},error(){}}, Math, JSON,
 Date:{now:()=>now,parse:Date.parse}, Promise,
 location:{protocol:'https:',host:'h.example',href:''}, WebSocket:FakeWS,
 document:{hidden:false,addEventListener(){},getElementById:()=>el,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>({style:{},classList:{add(){},remove(){}},appendChild(){}}),body:{appendChild(){}},documentElement:{}},
 localStorage:{getItem:()=>null,setItem(){}},
 CustomEvent:class{constructor(type,options){this.type=type;this.detail=options?.detail;}},
 dispatchEvent:e=>{seenEvents.push(e);return true;},
 setInterval:(fn,ms)=>{const id=nextTimerId++;timers.set(id,{fn,ms,next:now+ms,repeat:true});return id;},
 clearInterval:id=>timers.delete(id),
 setTimeout:(fn,ms)=>{const id=nextTimerId++;timers.set(id,{fn,ms,next:now+ms,repeat:false});return id;},
 clearTimeout:id=>timers.delete(id), fetch:async()=>({json:async()=>({})}),
};
ctx.window=ctx;ctx.navigator={};vm.createContext(ctx);
vm.runInContext(src+'\n;this.__t={startRealtime,rtAfterResponse,get connected(){return rtConnected;},get autoCall(){return rtAutoCall;}};',ctx);
ctx.housiyHasCachedTerminalState = async () => false;
const T=ctx.__t;let polls=0;let pollImpl=async()=>({success:true, room:{room_code:'ROOM1'}, game:{status:'RUNNING'}});const poll=async()=>{polls++;return pollImpl();};
async function flush(){for(let i=0;i<8;i++) await Promise.resolve(); const due=[...timers.entries()].filter(([,t])=>t.next<=now+100); for(const [id,t] of due){t.fn();if(t.repeat)t.next+=t.ms;else timers.delete(id);} for(let i=0;i<8;i++) await Promise.resolve();}
(async()=>{
 T.startRealtime('ROOM1',poll); await flush();
 assert(sockets.length===1 && sockets[0].url==='wss://h.example/ws?room=ROOM1','connects once to same-origin room WebSocket');
 const socket=sockets[0];
 // The error callback must not reference connect()'s block-scoped `proto`.
 socket.onerror({type:'error'});
 assert(warningMessages.some(args=>args[0]==='[Housiy realtime] WebSocket connection error'),'WebSocket error handler logs the handshake failure without throwing ReferenceError');
 socket.readyState=1;
 socket.onmessage({data:JSON.stringify({event:'HELLO',t:'hello',hb:10000,room_code:'ROOM1',sequence:10})});await flush();
 assert(T.connected===true,'hello marks socket connected');
 assert(polls>=1,'hello performs one canonical reconnect snapshot');
 assert(![...timers.values()].some(t=>t.repeat&&t.ms===1500),'successful HELLO stops room HTTP fallback polling');
 let before=polls;
 socket.onmessage({data:JSON.stringify({event:'NUMBER_CALLED',event_id:'e1',room_id:101,room_code:'ROOM1',sequence:11,data:{number:42,auto_call_enabled:true,auto_call_interval_seconds:3}})});await flush();
 assert(polls===before,'number-called event is handled over WebSocket without ticket/results HTTP polling');
 assert(T.autoCall && T.autoCall.secs===3,'number-called event resets the automatic countdown from server settings');
 socket.onmessage({data:JSON.stringify({event:'NUMBER_MARKED',event_id:'mark-1',room_id:101,room_code:'ROOM1',sequence:12,data:{number:42,ticket_id:7}})});await flush();
 assert(polls===before,'ticket-mark event is handled over WebSocket without ticket/results HTTP polling');
 const afterFirstGameEvent=polls;
 socket.onmessage({data:JSON.stringify({event:'NUMBER_CALLED',event_id:'e1',room_id:101,room_code:'ROOM1',sequence:11,data:{number:42}})});await flush();
 assert(polls===afterFirstGameEvent,'duplicate event_id is discarded');
 assert(socket.sent.some(m=>m.event==='ACK_EVENT'&&m.data.event_id==='e1'),'client acknowledges delivered server events');
 before=polls;
 socket.onmessage({data:JSON.stringify({event:'NUMBER_CALLED',event_id:'gap-1',room_code:'ROOM1',sequence:15,data:{number:43}})});await flush();
 assert(polls>before,'sequence gap triggers authoritative snapshot recovery');
 before=polls;
 socket.onmessage({data:JSON.stringify({event:'NUMBER_CALLED',event_id:'wrong-room',room_code:'ROOM2',sequence:16,data:{number:44}})});await flush();
 assert(polls===before,'cross-room WebSocket event is rejected by the browser manager');
 before=polls;
 socket.onmessage({data:JSON.stringify({event:'EMOJI_REACTION',event_id:'e2',room_code:'ROOM1',sequence:0,data:{id:123}})});await flush();
 assert(polls===before,'reaction event does not refresh ticket/results');
 assert(seenEvents.some(e=>e.type==='housiy:realtime'&&e.detail.type==='reaction'),'reaction is dispatched to UI widgets');
 const command=ctx.housiyRealtimeSend('MARK_NUMBER',{number:42});
 const sent=socket.sent[socket.sent.length-1];
 assert(sent.event==='MARK_NUMBER'&&sent.data.number===42&&sent.room_code==='ROOM1','client command uses shared socket and room-scoped envelope');
 socket.onmessage({data:JSON.stringify({event:'COMMAND_RESULT',command_id:sent.command_id,data:{response:{success:true,number:42}}})});
 const result=await command;
 assert(result.success===true&&result.number===42,'command response resolves by command_id');
 before=polls;socket.close(1013,'test disconnect');await flush();
 assert(T.connected===false,'disconnect marks socket offline');
 assert(polls>before,'disconnect immediately starts HTTP fallback polling');
 assert(seenEvents.some(e=>e.type==='housiy:realtime'&&e.detail.type==='fallback'),'disconnect announces fallback mode to dependent widgets');
 assert([...timers.values()].some(t=>t.repeat&&t.ms===1500),'fallback schedules bounded 1.5s room snapshot polling');
 // Let the reconnect backoff fire, then authenticate the replacement socket.
 now += 2500; await flush();
 assert(sockets.length===2,'a disconnected client retries the same room WebSocket');
 const recovered=sockets[1]; recovered.readyState=1;
 let finishSnapshot; pollImpl=()=>new Promise(resolve=>{finishSnapshot=()=>resolve({success:true,room:{room_code:'ROOM1'},game:{status:'RUNNING'}});});
 recovered.onmessage({data:JSON.stringify({event:'HELLO',t:'hello',hb:10000,room_code:'ROOM1',sequence:20})}); await flush();
 assert(T.connected===false && [...timers.values()].some(t=>t.repeat&&t.ms===1500),'fallback remains active after HELLO while canonical snapshot is still pending');
 finishSnapshot(); pollImpl=async()=>({success:true,room:{room_code:'ROOM1'},game:{status:'RUNNING'}}); await flush();
 assert(T.connected===true,'replacement HELLO marks connected only after snapshot reconciliation succeeds');
 assert(![...timers.values()].some(t=>t.repeat&&t.ms===1500),'reconnect cancels the room HTTP fallback interval');
 assert(seenEvents.some(e=>e.type==='housiy:realtime'&&e.detail.type==='connected'),'reconnect announces fallback shutdown to dependent widgets');
 // Completed games retain the same socket for rematch lifecycle events only.
 T.rtAfterResponse({game:{status:'COMPLETED'},room:{status:'COMPLETED',room_code:'ROOM1'}});
 await flush();
 assert(T.connected===true && sockets.length===2,'completed game keeps the existing room WebSocket open');
 before=polls;
 const ackCount= recovered.sent.filter(m=>m.event==='ACK_EVENT').length;
 recovered.onmessage({data:JSON.stringify({event:'NUMBER_CALLED',event_id:'terminal-number',room_code:'ROOM1',sequence:21,data:{number:77}})}); await flush();
 assert(polls===before && recovered.sent.filter(m=>m.event==='ACK_EVENT').length===ackCount,'completed game ignores live number events and does not ACK them');
 recovered.onmessage({data:JSON.stringify({event:'EMOJI_REACTION',event_id:'terminal-reaction',room_code:'ROOM1',sequence:0,data:{id:124}})}); await flush();
 assert(seenEvents.some(e=>e.detail?.reaction?.id===124),'completed game accepts winner celebration reactions during the 10-second grace period');
  recovered.onmessage({data:JSON.stringify({event:'WINNER_DECLARED',event_id:'terminal-winner',room_code:'ROOM1',sequence:0,data:{prize_type:'FULL_HOUSE',winner_name:'Winner'}})}); await flush();
  assert(seenEvents.some(e=>e.detail?.type==='prize_won'&&e.detail?.reaction?.prize_type==='FULL_HOUSE'),'completed game still dispatches late winner declarations');
  recovered.onmessage({data:JSON.stringify({event:'PRIZE_CLAIMED',event_id:'terminal-prize-claimed',room_code:'ROOM1',sequence:0,data:{prize_type:'TOP_ROW',winner_name:'Another Winner'}})}); await flush();
  assert(seenEvents.some(e=>e.detail?.type==='prize_won'&&e.detail?.reaction?.prize_type==='TOP_ROW'),'completed game dispatches PRIZE_CLAIMED as a winner update');
 recovered.onmessage({data:JSON.stringify({event:'ROOM_STATE_SYNC',event_id:'rematch-created',room_code:'ROOM1',sequence:21,data:{reason:'rematch_created'}})}); await flush();
 assert(polls>before,'completed game still refreshes canonical state for rematch lifecycle events');
 recovered.onmessage({data:JSON.stringify({event:'GAME_STARTED',event_id:'rematch-game-started',room_code:'ROOM1',sequence:22,data:{game_id:2}})}); await flush();
 assert(sockets.length===2 && ctx.housiyGameTerminal===false,'accepted rematch resumes live events over the existing WebSocket without creating another connection');
 // A disconnect while waiting for rematch must still activate HTTP fallback.
 before=polls; recovered.close(1013,'test terminal disconnect'); await flush();
 assert(polls>before && [...timers.values()].some(t=>t.repeat&&t.ms===1500),'completed-game WebSocket outage still enables HTTP fallback polling');
 // --- Regression: poll responses must not bypass reconnect backoff.
 const socketsBeforeBackoff = sockets.length;
 T.rtAfterResponse({game:{status:'RUNNING'},room:{status:'LIVE',room_code:'ROOM1',auto_call_seconds_remaining:3}}); await flush();
 assert(sockets.length===socketsBeforeBackoff,'fallback poll responses do not bypass the reconnect backoff timer');
 now += 40000; await flush();
 assert(sockets.length===socketsBeforeBackoff+1,'the backoff timer itself performs the next reconnect attempt');
 // --- Regression: stall watchdog refreshes a silent but connected auto-calling room.
 const wd=sockets[sockets.length-1]; wd.readyState=1;
 wd.onmessage({data:JSON.stringify({event:'HELLO',t:'hello',hb:10000,room_code:'ROOM1',sequence:30})}); await flush();
 T.rtAfterResponse({game:{status:'RUNNING'},room:{status:'LIVE',room_code:'ROOM1',auto_call_seconds_remaining:3}}); await flush();
 assert(T.connected===true,'watchdog scenario: socket connected after HELLO');
 before=polls; now += 12000; await flush();
 assert(polls===before,'watchdog does not poll while the room is recently active');
 now += 25000; await flush(); await flush();
 assert(polls>before,'watchdog takes one canonical snapshot when a connected auto-calling room goes silent');
 console.log(failures?`\n${failures} FAILED`:'\nALL PASSED');process.exit(failures?1:0);
})();
