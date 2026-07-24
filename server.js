const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || 'bcbfae3acb5cd71f7f2704b9286b67d7';
const EMAIL_USER = process.env.EMAIL_USER || 'ivantamagni.it@gmail.com';
const EMAIL_PASSWORD = process.env.EMAIL_PASSWORD || 'cvyraiukhkfmyrmu';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup
const db = new sqlite3.Database('bluray_tracker.db', (err) => {
    if (err) console.error('Database error:', err);
    else console.log('Database connected');
});

// Create tables
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            year TEXT,
            amazon_url TEXT,
            ebay_url TEXT,
            dvdstore_url TEXT,
            alert_price_amazon REAL,
            alert_price_ebay REAL,
            alert_price_dvdstore REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            price REAL NOT NULL,
            url TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS alerts_sent (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            source TEXT NOT NULL,
            price REAL NOT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(product_id) REFERENCES products(id)
        )
    `);
});

// Email configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASSWORD
    }
});

// Web Scraping with ScraperAPI
async function scrapePrice(url, source) {
    try {
        const scraperUrl = `http://api.scraperapi.com?api_key=${SCRAPER_API_KEY}&url=${encodeURIComponent(url)}`;
        const response = await axios.get(scraperUrl, { timeout: 30000 });
        const html = response.data;

        let price = null;

        if (source === 'amazon') {
            const priceMatch = html.match(/data-a-color="price"[^>]*>[\s\S]*?<span[^>]*>(€|£|\$)?\s*([\d,\.]+)/);
            if (!priceMatch) {
                const altMatch = html.match(/<span class="a-price-whole"[^>]*>(€|£|\$)?\s*([\d,\.]+)/);
                if (altMatch) price = parseFloat(altMatch[2].replace(',', '.'));
            } else {
                price = parseFloat(priceMatch[2].replace(',', '.'));
            }
        } else if (source === 'ebay') {
            const priceMatch = html.match(/<span id="prcIsum"[^>]*>(€|£|\$)?\s*([\d,\.]+)/);
            if (!priceMatch) {
                const altMatch = html.match(/<span class="notranslate"[^>]*>(€|£|\$)?\s*([\d,\.]+)/);
                if (altMatch) price = parseFloat(altMatch[2].replace(',', '.'));
            } else {
                price = parseFloat(priceMatch[2].replace(',', '.'));
            }
        } else if (source === 'dvdstore') {
            const priceMatch = html.match(/<span class="price"[^>]*>(€|£|\$)?\s*([\d,\.]+)/);
            if (!priceMatch) {
                const altMatch = html.match(/<div class="product-price"[^>]*>(€|£|\$)?\s*([\d,\.]+)/);
                if (altMatch) price = parseFloat(altMatch[2].replace(',', '.'));
            } else {
                price = parseFloat(priceMatch[2].replace(',', '.'));
            }
        }

        return price;
    } catch (error) {
        console.error(`Error scraping ${source}:`, error.message);
        return null;
    }
}

// Send email notification
async function sendAlert(productTitle, source, currentPrice, alertPrice) {
    try {
        const mailOptions = {
            from: EMAIL_USER,
            to: EMAIL_USER,
            subject: `🎉 OFFERTA TROVATA - ${productTitle} su ${source}!`,
            html: `
                <h2>🎉 OFFERTA TROVATA!</h2>
                <p><strong>Film:</strong> ${productTitle}</p>
                <p><strong>Piattaforma:</strong> ${source}</p>
                <p><strong>Prezzo attuale:</strong> <span style="color: green; font-size: 1.2em;"><strong>€${currentPrice.toFixed(2)}</strong></span></p>
                <p><strong>Tuo limite:</strong> €${alertPrice.toFixed(2)}</p>
                <p style="color: green;"><strong>Hai risparmiato: €${(alertPrice - currentPrice).toFixed(2)}!</strong></p>
                <p>Vai a comprare prima che finisca! 🚀</p>
            `
        };

        await transporter.sendMail(mailOptions);
        console.log(`Alert sent for ${productTitle} on ${source}`);
    } catch (error) {
        console.error('Error sending email:', error);
    }
}

// API Routes

// GET all products
app.get('/api/products', (req, res) => {
    db.all(`
        SELECT p.*, 
               (SELECT price FROM prices WHERE product_id = p.id AND source = 'amazon' ORDER BY created_at DESC LIMIT 1) as latest_amazon,
               (SELECT price FROM prices WHERE product_id = p.id AND source = 'ebay' ORDER BY created_at DESC LIMIT 1) as latest_ebay,
               (SELECT price FROM prices WHERE product_id = p.id AND source = 'dvdstore' ORDER BY created_at DESC LIMIT 1) as latest_dvdstore,
               (SELECT MIN(price) FROM prices WHERE product_id = p.id AND source = 'amazon') as min_amazon,
               (SELECT MIN(price) FROM prices WHERE product_id = p.id AND source = 'ebay') as min_ebay,
               (SELECT MIN(price) FROM prices WHERE product_id = p.id AND source = 'dvdstore') as min_dvdstore
        FROM products p
        ORDER BY p.created_at DESC
    `, (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows || []);
    });
});

// GET product details
app.get('/api/products/:id', (req, res) => {
    const productId = req.params.id;
    
    db.get('SELECT * FROM products WHERE id = ?', [productId], (err, product) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all('SELECT * FROM prices WHERE product_id = ? ORDER BY created_at DESC', [productId], (err, prices) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ product, prices });
        });
    });
});

// ADD new product
app.post('/api/products', (req, res) => {
    const { title, year, amazon_url, ebay_url, dvdstore_url } = req.body;
    
    db.run(
        `INSERT INTO products (title, year, amazon_url, ebay_url, dvdstore_url) 
         VALUES (?, ?, ?, ?, ?)`,
        [title, year, amazon_url, ebay_url, dvdstore_url],
        function(err) {
            if (err) res.status(500).json({ error: err.message });
            else res.json({ id
