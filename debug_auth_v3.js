
const https = require('https');

async function getCookiesAndCsrf() {
  return new Promise((resolve) => {
    https.get('https://audit.frankzh.top/api/auth/csrf', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          cookies: res.headers['set-cookie'],
          csrfToken: JSON.parse(data).csrfToken
        });
      });
    });
  });
}

async function testRedirect() {
  const { cookies, csrfToken } = await getCookiesAndCsrf();
  
  const postData = `csrfToken=${csrfToken}&callbackUrl=https%3A%2F%2Faudit.frankzh.top&json=true`;
  
  const options = {
    hostname: 'audit.frankzh.top',
    port: 443,
    path: '/api/auth/signin/google',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': cookies.join('; '),
      'Content-Length': postData.length
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      console.log("Response Body:", data);
      const url = JSON.parse(data).url;
      console.log("OAuth URL:", url);
      if (url && url.includes('client_id')) {
        const params = new URLSearchParams(url.split('?')[1]);
        console.log("Client ID in URL:", params.get('client_id'));
      }
    });
  });

  req.on('error', console.error);
  req.write(postData);
  req.end();
}

testRedirect();
