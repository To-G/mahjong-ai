import { MahjongGame } from '../js/engine.js';
const g = new MahjongGame({ seed: 1001, thinkDelay: 0, players: [
  {name:'P0',type:'ai',persona:'prof',level:'hard'},
  {name:'P1',type:'ai',persona:'chatter',level:'normal'},
  {name:'P2',type:'ai',persona:'hothead',level:'hard'},
  {name:'P3',type:'ai',persona:'prof',level:'easy'}]});
try { await g.start(); console.log('OK'); } catch(e){ console.log(e.stack.split('\n').slice(0,14).join('\n')); }
