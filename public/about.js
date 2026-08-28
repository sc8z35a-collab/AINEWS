'use strict';
api('/api/news?limit=1').then(x=>updateGlobalStatus(x.meta)).catch(()=>{});
