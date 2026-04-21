
const https = require('https');

async function getCsrf() {
  return new Promise((resolve, reject) => {
    https.get('https://audit.frankzh.top/api/auth/csrf', (res) => {
      let data = '';
      res.on('data', (chunk) => data += data);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).csrfToken);
        } catch (e) {
          // If JSON fails, maybe it's just the token
          resolve(data);
        }
      });
    }).on('error', reject);
  });
}

async function getRedirectUrl() {
  // Use a simple GET first to see the form
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'audit.frankzh.top',
      port: 443,
      path: '/api/auth/signin/google',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    };

    const req = https.request(options, (res) => {
      resolve(res.headers.location);
    });

    req.on('error', (e) => {
      reject(e);
    });

    req.end();
  });
}

getRedirectUrl().then(url => {
  console.log("Redirect URL:", url);
  if (url) {
    const params = new URLSearchParams(url.split('?')[1]);
    console.log("Client ID in URL:", params.get('client_id'));
  } else {
    console.log("No redirect found. Server might be serving 200 OK with a form.");
  }
}).catch(console.error);
