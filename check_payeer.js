const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const csv = require('csv-parser');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(() => {
    console.log('MongoDB connected successfully');
}).catch(err => {
    console.error('MongoDB connection error:', err);
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

async function retryAction(action, maxRetries = 3, retryDelay = 2000) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            console.log(`Attempting action (try ${i + 1}/${maxRetries})...`);
            await action();
            console.log('Action successful.');
            return;
        } catch (error) {
            console.warn(`Action failed on attempt ${i + 1}. Retrying...`);
            if (i < maxRetries - 1) await new Promise(resolve => setTimeout(resolve, retryDelay));
            else throw error;
        }
    }
}

async function findPaymentInCSV(commentCode) {
    const downloadPath = path.join(__dirname, 'downloads');
    const files = fs.readdirSync(downloadPath);
    if (files.length === 0) {
        console.error('No CSV file found in downloads directory.');
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
                if (found) resolve(found);
                else {
                    console.log('Finished checking CSV file. Payment not found.');
                    resolve(null);
                }
            })
            .on('error', (err) => reject(err));
    });
}

async function checkPayment() {
    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: false,
            executablePath: 'C:\\Users\\Наблюдатель\\Desktop\\Tor Browser\\Browser\\firefox.exe',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
        });
        const pages = await browser.pages();
        const page = pages[0];
        for (let i = 1; i < pages.length; i++) {
            await pages[i].close();
        }

        const paymentToCheck = await Payment.findOne({ status: 'pending' });
        if (!paymentToCheck) {
            console.log('No pending payments to check.');
            return;
        }
        console.log(`Checking for payment with comment code: ${paymentToCheck.commentCode}`);

        await page.goto('https://payeer.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await humanLikeDelay(2000, 5000);

        console.log('Trying to log in...');
        await retryAction(async () => {
            await page.waitForSelector('body > section.section.section__first.section_gradient.section_hidden.tp_rm > div > div.intro > div > div:nth-child(1) > div > a.button.button_empty', { timeout: 10000 });
            await page.click('body > section.section.section__first.section_gradient.section_hidden.tp_rm > div > div.intro > div > div:nth-child(1) > div > a.button.button_empty');
            await page.waitForSelector('#login-step1 > div > div.login-form__content > form > div:nth-child(10) > input[type=text]', { timeout: 10000 });
            await page.type('#login-step1 > div > div.login-form__content > form > div:nth-child(10) > input[type=text]', process.env.PAYEER_LOGIN);
            await page.type('#login-step1 > div > div.login-form__content > form > div:nth-child(11) > input[type=password]', process.env.PAYEER_PASSWORD);
            await page.click('#login-step1 > div > div.login-form__content > form > button.login-form__login-btn.step1');
            await page.waitForNavigation({ timeout: 30000 });
        });

        const historyButtonSelector = 'body > div.page.w.wleftmini1 > main > div > aside > div.menu > ul:nth-child(1) > li.time';
        const exportButtonSelector = '#tab-myoperations > div.filter-action > a.link.export_csv';
        await retryAction(async () => {
            await page.click(historyButtonSelector);
            await page.waitForNavigation();
        });

        await retryAction(async () => {
            await page.waitForSelector(exportButtonSelector, { timeout: 60000 });
            const downloadPath = path.join(__dirname, 'downloads');
            if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });
            await page.click(exportButtonSelector);
            await humanLikeDelay(5000, 10000);
        });

        const paymentFoundInCSV = await findPaymentInCSV(paymentToCheck.commentCode);
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
    } finally {
        if (browser) await browser.close();
        mongoose.connection.close();
    }
}

checkPayment();