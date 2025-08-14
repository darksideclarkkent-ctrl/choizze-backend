const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 50000,
  connectTimeoutMS: 50000,
}).then(() => {
  console.log('MongoDB connected successfully');
}).catch(err => {
  console.error('MongoDB connection error:', err);
  process.exit(1);
});

const PaymentSchema = new mongoose.Schema({
  payeerId: { type: String, unique: true, sparse: true },
  userNickname: String,
  amount: Number,
  currency: String,
  status: { type: String, default: 'pending' },
  protectionCode: { type: String, required: true },
  commentCode: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', PaymentSchema);

async function humanLikeDelay(min, max) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  console.log(`Pausing for ${delay / 1000} seconds...`);
  return new Promise(resolve => setTimeout(resolve, delay));
}

async function retryAction(action, maxRetries = parseInt(process.env.MAX_RETRIES) || 3, retryDelay = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`Attempting action (try ${i + 1}/${maxRetries})...`);
      await action();
      console.log('Action successful.');
      return;
    } catch (error) {
      console.warn(`Action failed on attempt ${i + 1}: ${error.message}`);
      if (i < maxRetries - 1) await new Promise(resolve => setTimeout(resolve, retryDelay));
      else throw error;
    }
  }
}

async function findPaymentInCSV(commentCode, downloadPath) {
  console.log(`Searching for CSV in ${downloadPath}`);
  const files = fs.readdirSync(downloadPath).filter(file => file.endsWith('.csv'));
  if (files.length === 0) {
    console.error('No CSV files found in downloads directory.');
    return null;
  }
  const newestFile = files.map(file => ({
    name: file,
    time: fs.statSync(path.join(downloadPath, file)).mtime.getTime()
  })).sort((a, b) => b.time - a.time)[0].name;
  const filePath = path.join(downloadPath, newestFile);
  console.log(`Searching for payment with amount '1.00' and comment '${commentCode}' in file: ${filePath}`);

  return new Promise((resolve, reject) => {
    let found = null;
    fs.createReadStream(filePath)
      .pipe(csv({ separator: ';' }))
      .on('data', (row) => {
        console.log('Processing CSV row:', row);
        if (row.Amount === '1.00' && row[''] === 'RUB' && row.Description && row.Description.trim() === commentCode) {
          console.log('Payment found in CSV:', row);
          found = row;
        }
      })
      .on('end', () => {
        console.log('Finished checking CSV file.');
        resolve(found);
      })
      .on('error', (err) => {
        console.error('CSV parsing error:', err);
        reject(err);
      });
  });
}

async function checkPayment(orderId, commentCode) {
  let browser = null;
  try {
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
    console.log(`Launching Puppeteer with executablePath: ${executablePath}`);
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      timeout: 60000
    });
    const pages = await browser.pages();
    const page = pages[0];
    for (let i = 1; i < pages.length; i++) {
      await pages[i].close();
    }

    const paymentToCheck = orderId
      ? await Payment.findOne({ payeerId: orderId, commentCode })
      : await Payment.findOne({ status: 'pending', commentCode });
    
    if (!paymentToCheck) {
      console.log(`No pending payment found for order ${orderId || 'any'} with comment code: ${commentCode}`);
      return;
    }
    console.log(`Checking payment with order ID: ${paymentToCheck.payeerId}, comment code: ${paymentToCheck.commentCode}`);

    await page.goto('https://payeer.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await humanLikeDelay(1000, 3000);

    console.log('Attempting login...');
    await retryAction(async () => {
      await page.waitForSelector('a.button.button_empty', { timeout: 15000 });
      await page.click('a.button.button_empty');
      await page.waitForSelector('input[type=text]', { timeout: 10000 });
      await page.type('input[type=text]', process.env.PAYEER_LOGIN);
      await page.type('input[type=password]', process.env.PAYEER_PASSWORD);
      await page.click('button.login-form__login-btn.step1');
      await page.waitForNavigation({ timeout: 30000 });
      console.log('Login completed');
    });

    console.log('Navigating to history...');
    const historyButtonSelector = 'li.time';
    const exportButtonSelector = 'a.link.export_csv';
    await retryAction(async () => {
      await page.waitForSelector(historyButtonSelector, { timeout: 15000 });
      await page.click(historyButtonSelector);
      await page.waitForNavigation({ timeout: 30000 });
    });

    console.log('Downloading CSV...');
    await retryAction(async () => {
      const downloadPath = path.join(__dirname, 'downloads');
      if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
      const client = await page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath
      });
      await page.waitForSelector(exportButtonSelector, { timeout: 60000 });
      await page.click(exportButtonSelector);
      await humanLikeDelay(3000, 7000);
    });

    const paymentFoundInCSV = await findPaymentInCSV(paymentToCheck.commentCode, path.join(__dirname, 'downloads'));
    if (paymentFoundInCSV) {
      paymentToCheck.status = 'completed';
      paymentToCheck.payeerId = paymentFoundInCSV.ID;
      await paymentToCheck.save();
      console.log(`Payment for user ${paymentToCheck.userNickname} with code ${paymentToCheck.commentCode} found. Status updated to 'completed'. Payeer ID: ${paymentFoundInCSV.ID}`);
    } else {
      paymentToCheck.status = 'failed';
      await paymentToCheck.save();
      console.log(`Payment for user ${paymentToCheck.userNickname} with code ${paymentToCheck.commentCode} not found. Status updated to 'failed'.`);
    }
  } catch (error) {
    console.error('Error during PAYEER payment check:', error.message);
    throw error;
  } finally {
    if (browser) {
      console.log('Closing browser...');
      await browser.close();
    }
    console.log('Closing MongoDB connection...');
    await mongoose.connection.close();
  }
}

(async () => {
  const [,, orderId, commentCode] = process.argv;
  try {
    await checkPayment(orderId, commentCode || 'testcode123');
  } catch (error) {
    console.error('Script failed:', error.message);
    process.exit(1);
  }
})();