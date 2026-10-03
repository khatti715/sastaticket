const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

let browser = null;
let context = null;
let page = null;
let currentToken = null;

// Browser start (sirf ek baar)
async function initBrowser() {
  if (browser) return;
  browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36',
    viewport: { width: 390, height: 844 }
  });
  page = await context.newPage();
  console.log('Browser ready');
}

// Fresh token nikalne wala function
async function getFreshToken() {
  await initBrowser();
  
  // pehle site load
  await page.goto('https://www.sastaticket.pk/', { waitUntil: 'networkidle' });
  
  // Sign In click
  await page.click('text=Sign In').catch(() => {});
  await page.waitForTimeout(1500);

  // Network intercept for token
  let token = null;
  page.on('request', req => {
    const headers = req.headers();
    if (headers['x-aws-waf-token']) {
      token = headers['x-aws-waf-token'];
    }
  });

  // dummy number se OTP request trigger
  try {
    await page.fill('input[type="tel"], input[placeholder*="mobile"], input[name*="mobile"]', '03001234567');
    await page.click('button:has-text("Continue"), button:has-text("Send"), button:has-text("OTP")').catch(() => {});
    await page.waitForTimeout(3000);
  } catch (e) {}

  // agar token nahi mila to force generate
  if (!token) {
    const response = await page.evaluate(async () => {
      const res = await fetch('https://backend.sastaticket.pk/api/v3/users/generate_otp/', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'origin': 'https://www.sastaticket.pk',
          'referer': 'https://www.sastaticket.pk/',
          'source': 'web-app'
        },
        body: JSON.stringify({
          mobile_number: '+923001234567',
          otp_channel: 'whatsapp'
        })
      });
      return res.status;
    });
  }

  // last request se token nikaalo
  const requests = await page.context().storageState();
  // fallback: page se token force
  currentToken = token || await page.evaluate(() => {
    return window.localStorage.getItem('waf') || null;
  });

  return currentToken;
}

// Main endpoint
app.get('/send', async (req, res) => {
  try {
    let number = req.query.number;
    if (!number) {
      return res.status(400).json({ success: false, message: 'number required ?number=+92300...' });
    }
    if (!number.startsWith('+')) number = '+' + number.replace(/^0/, '92');

    // token nahi hai to naya le aao
    if (!currentToken) {
      currentToken = await getFreshToken();
    }

    // OTP bhejo
    const response = await page.evaluate(async (num, tok) => {
      const res = await fetch('https://backend.sastaticket.pk/api/v3/users/generate_otp/', {
        method: 'POST',
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'origin': 'https://www.sastaticket.pk',
          'referer': 'https://www.sastaticket.pk/',
          'source': 'web-app',
          'x-aws-waf-token': tok
        },
        body: JSON.stringify({
          mobile_number: num,
          otp_channel: 'whatsapp'
        })
      });
      return {
        status: res.status,
        data: await res.json().catch(() => res.text())
      };
    }, number, currentToken);

    // agar 403 aaya to token refresh + retry
    if (response.status === 403) {
      currentToken = await getFreshToken();
      // ek baar retry
      const retry = await page.evaluate(async (num, tok) => {
        const res = await fetch('https://backend.sastaticket.pk/api/v3/users/generate_otp/', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'origin': 'https://www.sastaticket.pk',
            'referer': 'https://www.sastaticket.pk/',
            'source': 'web-app',
            'x-aws-waf-token': tok
          },
          body: JSON.stringify({
            mobile_number: num,
            otp_channel: 'whatsapp'
          })
        });
        return { status: res.status, data: await res.json().catch(() => res.text()) };
      }, number, currentToken);
      return res.json({ success: true, number, ...retry });
    }

    res.json({ success: true, number, ...response });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.json({ message: 'Sasta Auto OTP ready. Use /send?number=+923001234567' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Running on ${PORT}`));