import {readFileSync} from 'fs';import {randomUUID} from 'crypto';
const [proxy,site,branch]=process.argv.slice(2);
const zip=readFileSync('/tmp/branchdeploy/s.zip');const b=`----NetlifyFormBoundary${randomUUID().replace(/-/g,'')}`;
const body=Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="branch"\r\n\r\n${branch}\r\n`),Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="zip"; filename="s.zip"\r\nContent-Type: application/zip\r\n\r\n`),zip,Buffer.from(`\r\n--${b}--\r\n`)]);
const r=await fetch(`${new URL(proxy).toString()}/api/v1/sites/${site}/builds?branch=${branch}`,{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${b}`,'user-agent':'netlify-mcp'},body});
console.log(r.status,(await r.text()).slice(0,800));
