const { Pool } = require('pg');
require('dotenv').config();

let pool;

if (process.env.DATABASE_URL) {
    // Если переменная окружения DATABASE_URL существует (как на Render), используем ее
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
            rejectUnauthorized: false
        }
    });
} else {
    // В противном случае, используем локальные настройки
    pool = new Pool({
        user: 'postgres',
        host: 'localhost',
        database: 'choizze_db',
        password: '2378',
        port: 5432,
    });
}

module.exports = {
    query: (text, params) => pool.query(text, params),
};