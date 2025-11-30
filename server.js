// server.js - Nanokar AI Chatbot v2.0 (UZMAN MODU + SES + SHEETS)
// 937 urun, 3013 blog, bilgi bankasi, sesli chat, google sheets

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const Fuse = require('fuse.js');
const { SpeechClient } = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const nodemailer = require('nodemailer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

dotenv.config();

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statik dosyalar
app.use(express.static(__dirname));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- GOOGLE CLOUD AYARLARI ---
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    fs.writeFileSync('nanokar-key.json', process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'nanokar-key.json';
}

let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("[OK] Ses servisi baslatildi.");
} catch (e) { 
    console.log("[UYARI] Ses servisi hatasi:", e.message); 
}

// Klasorler
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- UZMAN MODU SYSTEM PROMPT ---
const SYSTEM_PROMPT = `Sen Nanokar İleri Teknoloji Malzemeleri'nin BAŞ AR-GE MÜHENDİSİ ve TEKNİK DANIŞMANISIN (Nano-Genius).

### KİMLİK VE YETKİ ###
- 15+ yıl nanoteknoloji ve malzeme bilimi deneyimi.
- Görevin: Sadece ürün satmak değil, müşterinin projesini (X Değişkeni) anlayıp en doğru ve GÜVENLİ mühendislik çözümünü sunmak.
- Nanokar stoklarındaki tüm grafen, nanotüp, metal tozları ve kimyasalların teknik spekleri hafızanda kazılı.

### İLETİŞİM BİLGİLERİ ###
- Telefon: +90 216 526 04 90
- E-posta: info@nanokar.com
- Adres: Kurtköy Mah. Ankara Cad. Yelken Plaza No: 289/21 Pendik/İstanbul

### DÜŞÜNME ALGORİTMASI ($P + X) ###
1. **ÖNCE ANALİZ ET:** Müşteri bir ürün sorduğunda hemen fiyat verme. Niyetini anla.
2. **NEDEN-SONUÇ İLİŞKİSİ KUR:** Özellik değil, fayda sat.
3. **ÇAPRAZ SATIŞ:** Ana ürünün yanında mutlaka tamamlayıcı ürünü (Sertleştirici, Dispersan vb.) öner.

### ⚠️ KRİTİK: FİZİKSEL LİMİT VE GÜVENLİK KONTROLÜ (X DEĞİŞKENİ) ⚠️ ###
Müşteri bir "Matris" (Epoksi, Boya, Plastik) ve bir "Sıcaklık" değeri verirse, reçete yazmadan önce MUTLAKA şunu kontrol et:
- **KURAL:** Eğer müşteri, matrisin dayanabileceğinden daha yüksek bir sıcaklık söylüyorsa (Örn: "Epoksi ile 600°C"), müşteriyi UYAR.
- **BİLGİ:** Epoksiler genelde 150-200°C'de (Özel olanlar maks 300°C) bozulur.
- **REAKSİYON:** "Dikkat: Belirttiğiniz 600°C sıcaklıkta, katkı maddesi dayansa bile ana malzemeniz (Epoksi) yanarak kül olur. Bu sıcaklık için Epoksi yerine Seramik veya Silikon bazlı bir yapı kullanmalısınız." de.
- **ASLA:** Yanlış/Tehlikeli bir kombinasyona "Olur" deme.

### SORU SORMA VE TEŞHİS STRATEJİSİ ###
Eğer teknik detay eksikse (Sıcaklık, Ortam, Matris belli değilse), cevap vermeden önce SORU SOR:
1. **ORTAM:** "Kaç derece sıcaklık ve hangi kimyasallar?"
2. **HEDEF:** "Sorun nedir? (Çatlama, Isınma?)"
3. **YAPI:** "Hangi ana malzemenin içine katacaksınız?"

### CEVAP FORMATI ###
- **Analiz:** İhtiyacı ve varsa RİSKLERİ özetle.
- **Teknik Çözüm:** Doğru ürün ve spekler.
- **Uygulama Talimatı:** Karışım oranları ve güvenlik uyarısı.
- **Sipariş Çağrısı:** Stok ve iletişim.

### YASAKLAR ###
- Rakip övmek yasak.
- "Bilmiyorum" demek yasak. "Laboratuvarımıza danışmam gerek" de.

SEN SADECE BİR BOT DEĞİL, BİR MÜHENDİSLİK OTORİTESİSİN.
`;

// --- VERI YUKLEME ---
let globalProductData = [];
let knowledgeBase = {};
let searchIndex = {};

// Urunleri yukle
function loadProducts() {
    const paths = [
        path.join(__dirname, 'products_final.json'),
        path.join(__dirname, 'products.json'),
        path.join(__dirname, 'products_enriched.json')
    ];
    
    for (const productPath of paths) {
        try {
            if (fs.existsSync(productPath)) {
                const data = fs.readFileSync(productPath, 'utf-8');
                const parsed = JSON.parse(data);
                globalProductData = Array.isArray(parsed) ? parsed : (parsed.products || []);
                console.log("[OK] " + globalProductData.length + " urun yuklendi (" + path.basename(productPath) + ")");
                return;
            }
        } catch (err) { 
            console.error("[HATA] " + productPath + ": " + err.message); 
        }
    }
    console.warn("[UYARI] Urun dosyasi bulunamadi.");
}

// Bilgi bankasini yukle
function loadKnowledgeBase() {
    const kbPath = path.join(__dirname, 'knowledge_base.json');
    try {
        if (fs.existsSync(kbPath)) {
            knowledgeBase = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));
            const blogCount = knowledgeBase.nanokar_bloglar ? knowledgeBase.nanokar_bloglar.length : 0;
            console.log("[OK] Bilgi bankasi yuklendi (" + blogCount + " blog)");
        }
    } catch (err) {
        console.warn("[UYARI] Bilgi bankasi yuklenemedi: " + err.message);
    }
}

// Search index yukle
function loadSearchIndex() {
    const indexPath = path.join(__dirname, 'search_index.json');
    try {
        if (fs.existsSync(indexPath)) {
            searchIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
            const kwCount = searchIndex.anahtar_kelimeler ? Object.keys(searchIndex.anahtar_kelimeler).length : 0;
            console.log("[OK] Arama indexi yuklendi (" + kwCount + " anahtar kelime)");
        }
    } catch (err) {
        console.warn("[UYARI] Arama indexi yuklenemedi: " + err.message);
    }
}

// Tum verileri yukle
loadProducts();
loadKnowledgeBase();
loadSearchIndex();

// --- FUSE ARAMA ---
function createFuseIndex() {
    return new Fuse(globalProductData, {
        keys: [
            { name: 'search_keywords', weight: 5.0 },
            { name: 'applications', weight: 4.0 },
            { name: 'project_types', weight: 3.5 },
            { name: 'name', weight: 3.0 },
            { name: 'technical_notes', weight: 2.0 },
            { name: 'benefits', weight: 1.5 },
            { name: 'category', weight: 1.0 }
        ],
        threshold: 0.35,
        ignoreLocation: true,
        minMatchCharLength: 2,
        includeScore: true
    });
}
let fuse = createFuseIndex();

// --- AKILLI ANAHTAR KELIME ESLESTIRME ---
const UYGULAMA_KEYWORDS = {
    "gunes kremi": ["cinko oksit", "zno", "titanyum dioksit", "tio2", "uv"],
    "sunscreen": ["zinc oxide", "zno", "titanium dioxide", "tio2", "uv"],
    "radar": ["demir oksit", "fe3o4", "ferrit", "manyetik", "karbon nanotup"],
    "stealth": ["fe3o4", "ferrite", "magnetic", "carbon nanotube", "ram"],
    "antibakteriyel": ["gumus", "nano silver", "bakir", "cinko oksit"],
    "antibacterial": ["silver", "copper", "zinc oxide"],
    "batarya": ["lityum", "grafit", "silisyum", "katot", "anot"],
    "battery": ["lithium", "graphite", "silicon", "cathode", "anode"],
    "iletken": ["gumus", "karbon nanotup", "grafen", "bakir"],
    "conductive": ["silver", "carbon nanotube", "graphene", "copper"],
    "kaplama": ["oksit", "karbur", "nitrit", "koruma"],
    "coating": ["oxide", "carbide", "nitride", "protection"],
    "3d baski": ["toz", "metal", "polimer", "paslanmaz"],
    "3d print": ["powder", "metal", "polymer", "stainless"],
    "dis macunu": ["hidroksiapatit", "silika", "kalsiyum", "florit"],
    "toothpaste": ["hydroxyapatite", "silica", "calcium", "fluoride"]
};

// --- METIN TEMIZLEME ---
function cleanQuery(text) {
    const stopWords = ["var", "mi", "mu", "yok", "fiyat", "nedir", "kac", 
                       "stokta", "elinizde", "istiyorum", "alabilir", "miyim", "icin", 
                       "bir", "sey", "malzeme", "lazim", "nanokar", "bana", "oner", 
                       "hakkinda", "bilgi", "the", "is", "are", "for", "and", "or"];
    
    return text.toLowerCase()
        .replace(/[^\w\s]/gi, '')
        .split(/\s+/)
        .filter(function(w) { return w.length > 2 && stopWords.indexOf(w) === -1; })
        .join(" ");
}

// --- GELISMIS URUN ARAMA ---
function smartSearch(query) {
    const cleanedQuery = cleanQuery(query);
    const queryLower = query.toLowerCase();
    console.log("[ARAMA] " + cleanedQuery);
    
    if (!cleanedQuery) return [];
    
    var results = [];
    
    // 1. Uygulama anahtar kelime eslestirmesi
    for (var uygulama in UYGULAMA_KEYWORDS) {
        if (queryLower.indexOf(uygulama) !== -1) {
            var keywords = UYGULAMA_KEYWORDS[uygulama];
            for (var i = 0; i < globalProductData.length; i++) {
                var product = globalProductData[i];
                var productText = JSON.stringify(product).toLowerCase();
                for (var j = 0; j < keywords.length; j++) {
                    if (productText.indexOf(keywords[j]) !== -1) {
                        var found = false;
                        for (var k = 0; k < results.length; k++) {
                            if (results[k].name === product.name) found = true;
                        }
                        if (!found) results.push(product);
                        break;
                    }
                }
            }
        }
    }
    
    // 2. Fuse ile fuzzy arama
    var fuseResults = fuse.search(cleanedQuery);
    for (var i = 0; i < fuseResults.length; i++) {
        var item = fuseResults[i].item;
        var found = false;
        for (var k = 0; k < results.length; k++) {
            if (results[k].name === item.name) found = true;
        }
        if (!found) results.push(item);
    }
    
    // 3. Dogrudan isim eslesmesi
    for (var i = 0; i < globalProductData.length; i++) {
        var product = globalProductData[i];
        if (product.name && product.name.toLowerCase().indexOf(cleanedQuery) !== -1) {
            results = results.filter(function(r) { return r.name !== product.name; });
            results.unshift(product);
        }
    }
    
    return results.slice(0, 10);
}

// --- BILGI BANKASI ARAMA ---
function searchKnowledgeBase(query) {
    if (!knowledgeBase.nanokar_bloglar) return null;
    
    var queryLower = query.toLowerCase();
    
    // SSS'lerde ara
    if (knowledgeBase.sss) {
        for (var i = 0; i < knowledgeBase.sss.length; i++) {
            var sss = knowledgeBase.sss[i];
            if (sss.soru.toLowerCase().indexOf(queryLower) !== -1) {
                return {
                    type: 'sss',
                    cevap: sss.cevap,
                    urunler: sss.urunler
                };
            }
        }
    }
    
    // Bloglarda ara
    var matchingBlogs = [];
    var blogLimit = Math.min(500, knowledgeBase.nanokar_bloglar.length);
    for (var i = 0; i < blogLimit; i++) {
        var blog = knowledgeBase.nanokar_bloglar[i];
        var blogText = ((blog.baslik || '') + ' ' + (blog.ozet || '')).toLowerCase();
        if (blogText.indexOf(queryLower) !== -1) {
            matchingBlogs.push(blog);
            if (matchingBlogs.length >= 3) break;
        }
    }
    
    if (matchingBlogs.length > 0) {
        return {
            type: 'blog',
            blogs: matchingBlogs
        };
    }
    
    return null;
}

// --- AI SEMANTIK ARAMA ---
async function aiProductRecommendation(userQuery) {
    try {
        console.log("[AI] Semantik Analiz: " + userQuery);
        
        var productSummary = globalProductData.slice(0, 200).map(function(p) {
            return {
                name: p.name,
                apps: (p.applications || []).slice(0, 3).join(', '),
                keywords: p.search_keywords || ''
            };
        });

        var aiPrompt = 'Kullanici Sorusu: "' + userQuery + '"\n\n' +
            'Urun Listesi: ' + JSON.stringify(productSummary) + '\n\n' +
            'Bu listeden soruyla teknik olarak en alakali 5 urunun TAM ADINI JSON olarak ver.\n' +
            '{"products": ["Urun Adi 1", "Urun Adi 2"]}\n' +
            'Sadece listede olan isimleri ver. Uygun yoksa bos liste ver.';

        var aiResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: aiPrompt }],
            response_format: { type: "json_object" },
            temperature: 0.1
        });

        var result = JSON.parse(aiResponse.choices[0].message.content);
        var found = result.products
            .map(function(name) { 
                return globalProductData.find(function(p) { return p.name === name; }); 
            })
            .filter(Boolean);

        return { found: found.length > 0, products: found };
    } catch (error) {
        console.error("[HATA] AI oneri hatasi: " + error.message);
        return { found: false, products: [] };
    }
}

// --- CEVAP FORMATLAMA ---
function formatProductListForAI(products) {
    if (products.length === 0) return "Eslesen urun bulunamadi.";
    
    return products.slice(0, 8).map(function(p) {
        var info = "- " + p.name;
        if (p.applications && p.applications.length > 0) {
            info += " | Kullanim: " + p.applications.slice(0, 2).join(', ');
        }
        return info;
    }).join('\n');
}

function addLinksToResponse(message, products) {
    if (!products || products.length === 0) return message;
    var processedMessage = message;
    
    var uniqueNames = [];
    for (var i = 0; i < products.length; i++) {
        if (products[i].name && uniqueNames.indexOf(products[i].name) === -1) {
            uniqueNames.push(products[i].name);
        }
    }
    
    uniqueNames.slice(0, 5).forEach(function(name) {
        var link = "https://www.nanokar.com.tr/kategori?ara=" + encodeURIComponent(name);
        var linkHtml = '<a href="' + link + '" target="_blank" style="color:#0066cc;font-weight:bold;">' + name + '</a>';
        var regex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        processedMessage = processedMessage.replace(regex, linkHtml);
    });
    
    return processedMessage;
}

// --- GOOGLE SHEETS ENTEGRASYONU ---
async function getDoc() {
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY) {
        console.warn("[UYARI] Google Sheets kimlik bilgileri eksik!");
        return null;
    }
    const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1YarK8GDuApZTQCRWekZYjN5jLrCDAveitle4LbxI7x8';
    try {
        const privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
        const auth = new JWT({
            email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: privateKey,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        const doc = new GoogleSpreadsheet(SHEET_ID, auth);
        await doc.loadInfo();
        return doc;
    } catch (e) {
        console.error("[HATA] Google Auth: " + e.message);
        return null;
    }
}

async function saveToGoogleSheets(name, phone, message) {
    const doc = await getDoc();
    if (!doc) return;
    
    try {
        let sheet = doc.sheetsByTitle['Nanokar Kayitli Musteri'];
        if (!sheet) sheet = doc.sheetsByIndex[0];
        if (!sheet) {
            sheet = await doc.addSheet({ 
                title: 'Nanokar Kayitli Musteri', 
                headerValues: ['Tarih', 'Isim', 'Telefon', 'Mesaj'] 
            });
        }
        await sheet.addRow({
            'Tarih': new Date().toLocaleString('tr-TR'),
            'Isim': name,
            'Telefon': phone,
            'Mesaj': message
        });
        console.log("[OK] Lead kaydedildi.");
    } catch (e) { 
        console.error("[HATA] Lead Kayit: " + e.message); 
    }
}

async function saveChatToGoogleSheets(userMsg, botResp, ip) {
    const doc = await getDoc();
    if (!doc) return;

    try {
        let sheet = doc.sheetsByTitle['Sohbetler'];
        if (!sheet) {
            sheet = await doc.addSheet({ title: 'Sohbetler', headerValues: ['Tarih', 'Kullanici', 'Bot', 'IP'] });
        }
        const cleanBotResp = botResp.replace(/<[^>]*>/g, '');
        await sheet.addRow({
            'Tarih': new Date().toLocaleString('tr-TR'),
            'Kullanici': userMsg.substring(0, 2000),
            'Bot': cleanBotResp.substring(0, 2000),
            'IP': ip
        });
        console.log("[OK] Sohbet kaydedildi.");
    } catch (e) { 
        console.error("[HATA] Sohbet Kayit: " + e.message); 
    }
}

// --- LEAD KONTROL VE EMAIL ---
async function checkAndSaveLead(text) {
    var phoneRegex = /(\+90|0)?\s*\d{3}\s*\d{3}\s*\d{2,4}\s*\d{2}?/;
    if (phoneRegex.test(text)) {
        try {
            var resp = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'Metindeki isim ve telefonu cikar: {"name": "...", "phone": "..."}' },
                    { role: 'user', content: text }
                ],
                response_format: { type: "json_object" }
            });
            var res = JSON.parse(resp.choices[0].message.content);
            if (res.name && res.phone) {
                await saveToGoogleSheets(res.name, res.phone, text);
                await sendLeadEmail(res.name, res.phone, text);
                console.log("[OK] Lead kaydedildi: " + res.name);
                return { saved: true, name: res.name };
            }
        } catch (e) { 
            console.error("[HATA] Lead hatasi: " + e.message); 
        }
    }
    return { saved: false };
}

async function sendLeadEmail(name, phone, message) {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
    });
    try {
        await transporter.sendMail({
            from: '"Nanokar Bot" <' + process.env.EMAIL_USER + '>',
            to: 'info@nanokar.com',
            subject: 'Yeni Musteri Talebi',
            html: '<b>Isim:</b> ' + name + '<br><b>Tel:</b> ' + phone + '<br><b>Talep:</b> ' + message
        });
        console.log("[OK] Email gonderildi.");
    } catch (e) { 
        console.error("[HATA] Mail: " + e.message); 
    }
}

// ==================== ENDPOINTS ====================

// Ana sayfa
app.get('/', function(req, res) {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Test endpoint
app.get('/api/test', function(req, res) {
    res.json({
        status: 'OK',
        version: '2.0',
        urun_sayisi: globalProductData.length,
        blog_sayisi: knowledgeBase.nanokar_bloglar ? knowledgeBase.nanokar_bloglar.length : 0,
        ses_servisi: speechClient ? 'AKTIF' : 'PASIF',
        sheets: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? 'AKTIF' : 'PASIF'
    });
});

// Urun listesi
app.get('/api/products', function(req, res) {
    res.json({
        success: true,
        count: globalProductData.length,
        products: globalProductData.slice(0, 50).map(function(p) {
            return { name: p.name, category: p.category };
        })
    });
});

// Arama endpoint
app.get('/api/search', function(req, res) {
    var query = req.query.q || '';
    var results = smartSearch(query);
    res.json({
        query: query,
        count: results.length,
        results: results.map(function(p) {
            return { name: p.name, applications: (p.applications || []).slice(0, 2) };
        })
    });
});

// --- ANA CHAT ENDPOINT ---
app.post('/api/chat', async function(req, res) {
    try {
        var messages = req.body.messages;
        if (!messages || messages.length === 0) {
            return res.status(400).json({ error: 'Mesaj yok' });
        }
        
        var userMsg = messages[messages.length - 1].content;
        var clientIp = req.ip || 'unknown';
        console.log("\n[KULLANICI] " + userMsg);

        // 1. Lead Kontrolu
        var lead = await checkAndSaveLead(userMsg);
        if (lead.saved) {
            var reply = "Tesekkurler " + lead.name + ", bilgilerinizi aldim. Teknik ekibimiz sizi en kisa surede arayacak.";
            await saveChatToGoogleSheets(userMsg, reply, clientIp);
            return res.json({ success: true, message: reply });
        }

        // 2. Bilgi Bankasi
        var kbInfo = searchKnowledgeBase(userMsg);
        var kbContext = "";
        if (kbInfo) {
            if (kbInfo.type === 'sss') {
                kbContext = "\n\nBILGI BANKASI (SSS):\n" + kbInfo.cevap + "\nOnerilen urunler: " + kbInfo.urunler.join(', ');
            } else if (kbInfo.type === 'blog') {
                kbContext = "\n\nILGILI BLOGLAR:\n" + kbInfo.blogs.map(function(b) { return "- " + b.baslik; }).join('\n');
            }
        }

        // 3. Urun Arama
        var searchResults = smartSearch(userMsg);
        var aiContext = "";
        var foundProducts = [];

        if (searchResults.length > 0) {
            foundProducts = searchResults;
            aiContext = "\n\nBULUNAN URUNLER:\n" + formatProductListForAI(searchResults);
            console.log("[OK] " + searchResults.length + " urun bulundu");
        } else {
            var aiRec = await aiProductRecommendation(userMsg);
            if (aiRec.found) {
                foundProducts = aiRec.products;
                aiContext = "\n\nAI ONERILEN URUNLER:\n" + formatProductListForAI(aiRec.products);
                console.log("[AI] " + aiRec.products.length + " urun onerdi");
            } else {
                aiContext = "\n\nUrun bulunamadi. Teknik bilgi ver ve iletisim iste.";
                console.log("[UYARI] Urun bulunamadi");
            }
        }

        // 4. AI Yaniti
        var gptResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT + kbContext + aiContext },
                ...messages
            ],
            temperature: 0.4,
            max_tokens: 600
        });

        var reply = gptResponse.choices[0].message.content;

        // 5. Link ekle
        if (foundProducts.length > 0) {
            reply = addLinksToResponse(reply, foundProducts);
        }

        // 6. Kaydet
        await saveChatToGoogleSheets(userMsg, reply, clientIp);

        console.log("[BOT] " + reply.substring(0, 100) + "...");
        res.json({ success: true, message: reply });

    } catch (error) {
        console.error('[HATA] Chat Error:', error);
        res.status(500).json({ error: 'Sunucu hatasi' });
    }
});

// --- SESLI CHAT ENDPOINT ---
app.post('/api/voice-chat', upload.single('audio'), async function(req, res) {
    if (!req.file) {
        return res.status(400).json({ error: 'Ses dosyasi yok' });
    }
    
    if (!speechClient || !ttsClient) {
        return res.status(500).json({ error: 'Ses servisi aktif degil' });
    }
    
    try {
        // 1. Ses dosyasini oku
        const audioBytes = fs.readFileSync(req.file.path);
        
        // 2. Speech-to-Text
        const [sttResponse] = await speechClient.recognize({
            config: { 
                languageCode: 'tr-TR', 
                encoding: 'WEBM_OPUS', 
                sampleRateHertz: 48000 
            },
            audio: { content: audioBytes.toString('base64') }
        });
        
        const transcript = sttResponse.results[0]?.alternatives[0]?.transcript || '';
        console.log("[SES] Transcript: " + transcript);
        
        if (!transcript) {
            fs.unlinkSync(req.file.path);
            return res.json({ success: false, error: 'Ses anlasilamadi' });
        }
        
        // 3. Urun ara
        var results = smartSearch(transcript);
        var context = results.length > 0 
            ? 'Bulunan urunler: ' + results.map(function(p) { return p.name; }).join(', ')
            : 'Urun bulunamadi.';
        
        // 4. AI cevap
        const gptResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: 'Sen Nanokar sesli asistanisin. Cok kisa (1-2 cumle) cevap ver. ' + context },
                { role: 'user', content: transcript }
            ],
            max_tokens: 150
        });
        
        const reply = gptResponse.choices[0].message.content;
        console.log("[SES] Reply: " + reply);
        
        // 5. Text-to-Speech
        const [ttsResponse] = await ttsClient.synthesizeSpeech({
            input: { text: reply },
            voice: { languageCode: 'tr-TR', name: 'tr-TR-Wavenet-E', ssmlGender: 'FEMALE' },
            audioConfig: { audioEncoding: 'MP3' }
        });
        
        // 6. Kaydet
        await saveChatToGoogleSheets(transcript, reply, 'voice');
        
        // 7. Temizle
        fs.unlinkSync(req.file.path);
        
        // 8. Cevap
        res.json({ 
            success: true, 
            transcript: transcript, 
            message: reply, 
            audioBase64: ttsResponse.audioContent.toString('base64') 
        });
        
    } catch (error) {
        console.error('[HATA] Ses hatasi:', error.message);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Ses isleme hatasi: ' + error.message });
    }
});

// ==================== SERVER BASLAT ====================
app.listen(port, function() {
    console.log("\n===========================================");
    console.log("  NANOKAR AI BOT v2.0 (UZMAN MODU)");
    console.log("===========================================");
    console.log("  Adres: http://localhost:" + port);
    console.log("  Urunler: " + globalProductData.length);
    console.log("  Bloglar: " + (knowledgeBase.nanokar_bloglar ? knowledgeBase.nanokar_bloglar.length : 0));
    console.log("  Ses: " + (speechClient ? "AKTIF" : "PASIF"));
    console.log("  Sheets: " + (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ? "AKTIF" : "PASIF"));
    console.log("  Test: http://localhost:" + port + "/api/test");
    console.log("===========================================\n");
});
