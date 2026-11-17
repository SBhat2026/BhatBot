'use strict';
const assert = require('assert');
const {arrangeBounds}=require('../lib/smart-windows');
const {createPressureTracker}=require('../lib/memrelief');
for (const area of [{x:-1920,y:50,width:1920,height:1030},{x:0,y:0,width:1024,height:768}]) for(let count=1;count<=8;count++) {
 const bs=arrangeBounds(area,count);assert.equal(bs.length,count);
 bs.forEach(b=>{assert(b.x>=area.x&&b.y>=area.y&&b.width>0&&b.height>0);assert(b.x+b.width<=area.x+area.width);assert(b.y+b.height<=area.y+area.height)});
 for(let i=0;i<bs.length;i++)for(let j=i+1;j<bs.length;j++){const a=bs[i],b=bs[j];assert(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y)}
}
let track=createPressureTracker();assert.equal(track(9).active,false);assert.equal(track(8).active,true);assert.equal(track(15).active,true);assert.equal(track(20).active,true);assert.equal(track(20).active,true);assert.equal(track(20).active,false);
track=createPressureTracker();assert.equal(track(4).level,'critical');assert.equal(track(null).active,true);
console.log('Window geometry and memory pressure hysteresis passed');
