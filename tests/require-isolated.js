const {URL}=require('node:url');
const url=process.env.DATABASE_URL?new URL(process.env.DATABASE_URL):null;
if(process.env.FERRARO_TEST_ISOLATED!=='1'||!url||!['127.0.0.1','localhost'].includes(url.hostname)||!/^\/ferraro_test_[a-f0-9]{16}$/.test(url.pathname))throw new Error('Tests con escrituras bloqueados. Usá pnpm test para crear una base aislada.');
