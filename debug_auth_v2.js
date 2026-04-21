
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
    console.log("Status Code:", res.statusCode);
    console.log("Redirect URL:", res.headers.location);
    if (res.headers.location) {
      const url = new URL(res.headers.location);
      console.log("Client ID:", url.searchParams.get('client_id'));
    }
  });

  req.write(postData);
  req.end();
}

testRedirect();
