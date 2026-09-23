// canary: deliberately slow, to prove the drift check fires
const t=Date.now(); while(Date.now()-t<22000){} console.log('slow canary done');
