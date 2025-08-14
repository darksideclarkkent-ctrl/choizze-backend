const puppeteer = require('puppeteer');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs').promises; // Используем асинхронную версию fs
const csv = require('csv-parser');
const { createReadStream } = require('fs');
require('dotenv').config();

// Подключаемся к MongoDB один раз в начале
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
    const files = await fs.readdir(downloadPath);
    if (files.length === 0) {
        console.error('No CSV file found in downloads directory.');
        return null;
    }

    const newestFile = (await Promise.all(files.map(async file => {
        const stats = await fs.stat(path.join(downloadPath, file));
        return { name: file, time: stats.mtime.getTime() };
    }))).sort((a, b) => b.time - a.time)[0].name;

    const filePath = path.join(downloadPath, newestFile);
    console.log(`Searching for payment with amount '1.00' and comment '${commentCode}' in file: ${filePath}`);

    return new Promise((resolve, reject) => {
        let found = null;
        createReadStream(filePath)
            .pipe(csv({ separator: ';' }))
            .on('data', (row) => {
                if (row.Amount === '1.00' && row.Currency === 'RUB' && row.Description && row.Description.trim() === commentCode) {
                    found = row;
                }
            })
            .on('end', async () => {
                // Удаляем файл после проверки
                await fs.unlink(filePath);
                console.log(`CSV file ${newestFile} deleted.`);
                if (found) resolve(found);
                else {
                    console.log('Finished checking CSV file. Payment not found.');
                    resolve(null);
                }
            })
            .on('error', (err) => {
                console.error('Error reading CSV:', err);
                reject(err);
            });
    });
}

async function checkPayment() {
    let browser;
    try {
        const paymentToCheck = await Payment.findOne({ status: 'pending' });
        if (!paymentToCheck) {
            console.log('No pending payments to check.');
            return;
        }
        console.log(`Checking for payment with comment code: ${paymentToCheck.commentCode}`);
        
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        await page.goto('https://payeer.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
        await humanLikeDelay(2000, 5000);

        console.log('Trying to log in...');
        await retryAction(async () => {
            // Исправленные селекторы, если они были неверны
            await page.waitForSelector('.button.button_empty', { timeout: 10000 });
            await page.click('.button.button_empty');
            
            await page.waitForSelector('#login-step1 input[type=text]', { timeout: 10000 });
            await page.type('#login-step1 input[type=text]', process.env.PAYEER_LOGIN);
            await page.type('#login-step1 input[type=password]', process.env.PAYEER_PASSWORD);
            await page.click('#login-step1 button.login-form__login-btn');
            await page.waitForNavigation({ timeout: 30000 });
        });

        const historyButtonSelector = '.menu .time';
        const exportButtonSelector = '#tab-myoperations .link.export_csv';
        await retryAction(async () => {
            await page.waitForSelector(historyButtonSelector, { timeout: 10000 });
            await page.click(historyButtonSelector);
            await page.waitForNavigation({ waitUntil: 'domcontentloaded' });
        });

        await retryAction(async () => {
            const downloadPath = path.join(__dirname, 'downloads');
            await fs.mkdir(downloadPath, { recursive: true });
            
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath
            });
            
            await page.waitForSelector(exportButtonSelector, { timeout: 60000 });
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
        if (browser) {
            await browser.close();
            console.log('Browser closed.');
        }
        await mongoose.connection.close();
        console.log('MongoDB connection closed.');
    }
}

checkPayment();