// server.js - Nanokar AI Chatbot v2.2 (MULTI-LANGUAGE + SALES LOGIC + FILE SYSTEM)
// Özellikler: Türkçe-İngilizce çapraz arama, Satış Stratejisi, Dosya Tabanlı Prompt

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

// --- DİNAMİK SYSTEM PROMPT YÖNETİMİ ---
let SYSTEM_PROMPT = "";

function loadSystemPrompt() {
    const promptPath = path.join(__dirname, 'system_prompt.txt');
    try {
        if (fs.existsSync(promptPath)) {
            SYSTEM_PROMPT = fs.readFileSync(promptPath, 'utf8');
            console.log("[OK] System Prompt dosyadan yuklendi.");
        } else {
            throw new Error("Dosya bulunamadi");
        }
    } catch (err) {
        console.warn("[UYARI] Prompt dosyasi okunamadi, YEDEK PROMPT devreye girdi.");
        // YEDEK PROMPT (Dosya silinirse bu calisir - Güvenlik ve Satış Mantığı Dahil)
        SYSTEM_PROMPT = `Sen Nanokar İleri Teknoloji Malzemeleri'nin BAŞ AR-GE MÜHENDİSİ ve TEKNİK DANIŞMANISIN (Nano-Genius).

### KİMLİK VE YETKİ ###
- 15+ yıl nanoteknoloji ve malzeme bilimi deneyimi.
- Görevin: Sadece ürün satmak değil, müşterinin projesini anlamak ve en doğru mühendislik çözümünü sunmak.

### ⚠️ KRİTİK GÜVENLİK PROTOKOLÜ ⚠️ ###
Müşteri bir "Matris" (Epoksi, Boya, Plastik) ve bir "Sıcaklık" değeri verirse:
1. **Zayıf Halka Analizi:** Katkı maddesi dayansa bile, Ana Malzeme (Örn: Epoksi) kaç derecede bozulur?
2. **KURAL:** Müşteri matrisin limitini aşan bir sıcaklık söylerse (Örn: "Epoksi ile 600°C"), SERTÇE UYAR.
3. **BİLGİ:** Epoksiler ~200-300°C'de yanar.

### TİCARİ STRATEJİ: ÜRÜN STOKTA YOKSA (HAMMADDE ÖNER) ###
Kullanıcı karmaşık bir bileşik (Örn: LFP, NMC, YBCO, Boya) sorduğunda ve hazır ürün yoksa:
1. **Kimyasal Ayrıştırma:** İstenen malzemenin bileşenleri nedir?
2. **Stok Eşleştirmesi:** Stoklarında bu bileşenlerin "Metal Oksit" veya "Nano Toz" halleri var mı?
3. **Mühendislik Teklifi:** "Hazır LFP tozumuz yok ANCAK LFP sentezi yapabileceğiniz yüksek saflıkta Nano Demir Oksit stoklarımızda mevcuttur" de.

### CEVAP FORMATI ###
1. **Analiz:** İhtiyacı ve varsa riskleri özetle.
2. **Teknik Çözüm:** Doğru ürün veya alternatif hammadde.
3. **Uygulama İpucu:** Teknik detay.
4. **Sipariş Çağrısı:** Stok ve iletişim.`;
    }
}

// Baslangicta promptu yukle
loadSystemPrompt();

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

// --- FUSE ARAMA AYARLARI ---
function createFuseIndex() {
    return new Fuse(globalProductData, {
        keys: [
            { name: 'search_keywords', weight: 5.0 },
            { name: 'name', weight: 4.0 }, // Isim agirligini artirdik
            { name: 'applications', weight: 3.5 },
            { name: 'project_types', weight: 3.0 },
            { name: 'technical_notes', weight: 2.0 },
            { name: 'category', weight: 1.0 }
        ],
        threshold: 0.35, // Eslesme hassasiyeti
        ignoreLocation: true,
        minMatchCharLength: 2,
        includeScore: true
    });
}
let fuse = createFuseIndex();

// --- TR-EN SÖZLÜK VE KEYWORDS ---
const ELEMENT_DICTIONARY = {
    "gümüş": "silver", "gumus": "silver",
    "altın": "gold", "altin": "gold",
    "bakır": "copper", "bakir": "copper",
    "demir": "iron",
    "çinko": "zinc", "cinko": "zinc",
    "kurşun": "lead", "kursun": "lead",
    "kalay": "tin",
    "nikel": "nickel",
    "alüminyum": "aluminium", "aluminum": "aluminum",
    "titanyum": "titanium", "titan": "titanium",
    "karbon": "carbon",
    "silisyum": "silicon",
    "bor": "boron",
    "kükürt": "sulfur",
    "oksit": "oxide",
    "karbür": "carbide",
    "nitrür": "nitride",
    "sülfür": "sulfide",
    "nanotüp": "nanotube", "nanotup": "nanotube"
};

const UYGULAMA_KEYWORDS = {
    "gunes kremi": ["cinko oksit", "zno", "titanyum dioksit", "tio2", "uv"],
    "sunscreen": ["zinc oxide", "zno", "titanium dioxide", "tio2", "uv"],
    "radar": ["demir oksit", "fe3o4", "ferrit", "manyetik", "karbon nanotup", "ram"],
    "stealth": ["fe3o4", "ferrite", "magnetic", "carbon nanotube", "ram"],
    "antibakteriyel": ["gumus", "nano silver", "bakir", "cinko oksit"],
    "antibacterial": ["silver", "copper", "zinc oxide"],
    "batarya": ["lityum", "grafit", "silisyum", "katot", "anot"],
    "battery": ["lithium", "graphite", "silicon", "cathode", "anode"]
};

// --- METIN TEMIZLEME ---
function cleanQuery(text) {
    const stopWords = ["var", "mi", "mu", "yok", "fiyat", "nedir", "kac", 
                       "stokta", "elinizde", "istiyorum", "alabilir", "miyim", "icin", 
                       "bir", "sey", "malzeme", "lazim", "nanokar", "bana", "oner"];
    
    return text.toLowerCase()
        .replace(/[^\w\s]/gi, '') // Ozel karakterleri sil
        .split(/\s+/)
        .filter(function(w) { return w.length > 2 && stopWords.indexOf(w) === -1; })
        .join(" ");
}

// --- GELISMIS AKILLI ARAMA (DİL DESTEKLİ) ---
function smartSearch(query) {
    // 1. Sorguyu Temizle
    let cleanedQuery = cleanQuery(query);
    let queryLower = query.toLowerCase();
    
    // 2. ÇEVİRİ KATMANI: Türkçe kelime varsa İngilizcesini de sorguya ekle
    // Örn: "Nano Gümüş" -> "Nano Gümüş Silver" olur.
    for (let trKey in ELEMENT_DICTIONARY) {
        if (queryLower.includes(trKey)) {
            const enTerm = ELEMENT_DICTIONARY[trKey];
            // Sadece kelime sorguda yoksa ekle (Tekrarı önle)
            if (!cleanedQuery.includes(enTerm)) {
                cleanedQuery += " " + enTerm;
            }
        }
    }

    console.log("[ARAMA - DIL DESTEKLI] " + cleanedQuery);
    
    if (!cleanedQuery) return [];
    
    var results = [];
    
    // 3. Uygulama anahtar kelime eslestirmesi
    for (var uygulama in UYGULAMA_KEYWORDS) {
        if (queryLower.indexOf(uygulama) !== -1) {
            var keywords = UYGULAMA_KEYWORDS[uygulama];
            for (var i = 0; i < globalProductData.length; i++) {
                var product = globalProductData[i];
                var productText = JSON.stringify(product).toLowerCase();
                for (var j = 0; j < keywords.length; j++) {
                    if (productText.indexOf(keywords[j]) !== -1) {
                        if (!results.find(r => r.name === product.name)) results.push(product);
                        break;
                    }
                }
            }
        }
    }
    
    // 4. Fuse ile fuzzy arama (Artık "Silver" kelimesini de arıyor)
    var fuseResults = fuse.search(cleanedQuery);
    for (var i = 0; i < fuseResults.length; i++) {
        var item = fuseResults[i].item;
        if (!results.find(r => r.name === item.name)) results.push(item);
    }
    
    // 5. Basit Text Araması (Yedek)
    // Eğer Fuse bulamazsa, kelimeleri tek tek kontrol et
    for (var i = 0; i < globalProductData.length; i++) {
        var product = globalProductData[i];
        if (product.name) {
            let pName = product.name.toLowerCase();
            let searchTerms = cleanedQuery.split(' ');
            
            for(let term of searchTerms) {
                if(term.length > 3 && pName.includes(term)) {
                    if (!results.find(r => r.name === product.name)) {
                        results.push(product);
                    }
                }
            }
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

// --- AI SEMANTIK ONERI ---
async function aiProductRecommendation(userQuery) {
    try {
        console.log("[AI] Semantik Analiz: " + userQuery);
        
        // Sadece ilk 200 urunu ozet olarak gonder (Token limiti icin)
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

// --- FORMATLAMA FONKSIYONLARI ---
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
        // Basit linkleme: URL encode ederek arama sayfasina yonlendir
        var link = "https://www.nanokar.com.tr/kategori?ara=" + encodeURIComponent(name);
        var linkHtml = '<a href="' + link + '" target="_blank" style="color:#0066cc;font-weight:bold;">' + name + '</a>';
        var regex = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        processedMessage = processedMessage.replace(regex, linkHtml);
    });
    
    return processedMessage;
}

// --- GOOGLE SHEETS & LEAD ---
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
            sheet = await doc.addSheet({ title: 'Nanokar Kayitli Musteri', headerValues: ['Tarih', 'Isim', 'Telefon', 'Mesaj'] });
        }
        await sheet.addRow({
            'Tarih': new Date().toLocaleString('tr-TR'),
            'Isim': name,
            'Telefon': phone,
            'Mesaj': message
        });
        console.log("[OK] Lead kaydedildi.");
    } catch (e) { console.error("[HATA] Lead Kayit: " + e.message); }
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
    } catch (e) { console.error("[HATA] Sohbet Kayit: " + e.message); }
}

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
                return { saved: true, name: res.name };
            }
        } catch (e) { console.error("[HATA] Lead hatasi: " + e.message); }
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
    } catch (e) { console.error("[HATA] Mail: " + e.message); }
}

// ==================== ENDPOINTS ====================

app.get('/', function(req, res) { res.sendFile(path.join(__dirname, 'index.html')); });

app.get('/api/test', function(req, res) {
    res.json({
        status: 'OK',
        version: '2.2',
        prompt_mode: fs.existsSync('system_prompt.txt') ? 'FILE (system_prompt.txt)' : 'BACKUP',
        urun_sayisi: globalProductData.length,
        ses: speechClient ? 'AKTIF' : 'PASIF'
    });
});

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

app.post('/api/chat', async function(req, res) {
    try {
        var messages = req.body.messages;
        if (!messages || messages.length === 0) return res.status(400).json({ error: 'Mesaj yok' });
        
        var userMsg = messages[messages.length - 1].content;
        var clientIp = req.ip || 'unknown';
        console.log("\n[KULLANICI] " + userMsg);
        
        // Development sirasinda her istekte promptu guncelle
        loadSystemPrompt();

        // 1. Lead Kayit
        var lead = await checkAndSaveLead(userMsg);
        if (lead.saved) {
            var reply = "Tesekkurler " + lead.name + ", bilgilerinizi aldim. Teknik ekibimiz sizi arayacak.";
            await saveChatToGoogleSheets(userMsg, reply, clientIp);
            return res.json({ success: true, message: reply });
        }

        // 2. Bilgi Bankasi
        var kbInfo = searchKnowledgeBase(userMsg);
        var kbContext = "";
        if (kbInfo) {
            if (kbInfo.type === 'sss') kbContext = "\n\nBILGI BANKASI:\n" + kbInfo.cevap;
            else if (kbInfo.type === 'blog') kbContext = "\n\nBLOGLAR:\n" + kbInfo.blogs.map(b => "- " + b.baslik).join('\n');
        }

        // 3. Urun Arama (Dil Destekli)
        var searchResults = smartSearch(userMsg);
        var aiContext = "";
        var foundProducts = [];

        if (searchResults.length > 0) {
            foundProducts = searchResults;
            aiContext = "\n\nBULUNAN URUNLER:\n" + formatProductListForAI(searchResults);
            console.log("[OK] " + searchResults.length + " urun bulundu");
        } else {
            // Urun yoksa AI'ya 'Alternatif Oner' sinyali gonder
            aiContext = "\n\nSTOKTA URUN BULUNAMADI. 'HAMMADDE ONERME' STRATEJISINI UYGULA.";
            console.log("[UYARI] Urun bulunamadi - Alternatif mod");
        }

        // 4. AI Cevap
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

        // 5. Linkleme
        if (foundProducts.length > 0) reply = addLinksToResponse(reply, foundProducts);

        // 6. Kayit
        await saveChatToGoogleSheets(userMsg, reply, clientIp);
        console.log("[BOT] " + reply.substring(0, 100) + "...");
        
        res.json({ success: true, message: reply });

    } catch (error) {
        console.error('[HATA] Chat Error:', error);
        res.status(500).json({ error: 'Sunucu hatasi' });
    }
});

// Sesli Chat (Google Cloud)
app.post('/api/voice-chat', upload.single('audio'), async function(req, res) {
    if (!req.file || !speechClient) return res.status(400).json({ error: 'Ses servisi hatali' });
    try {
        const audioBytes = fs.readFileSync(req.file.path);
        const [sttResponse] = await speechClient.recognize({
            config: { languageCode: 'tr-TR', encoding: 'WEBM_OPUS', sampleRateHertz: 48000 },
            audio: { content: audioBytes.toString('base64') }
        });
        const transcript = sttResponse.results[0]?.alternatives[0]?.transcript || '';
        
        if (!transcript) throw new Error("Ses anlasilmadi");

        // Basit arama ve cevap
        var results = smartSearch(transcript);
        var context = results.length > 0 ? 'Urunler: ' + results.map(p => p.name).join(', ') : 'Urun yok.';
        
        const gptResponse = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'system', content: 'Kisa cevap ver. ' + context }, { role: 'user', content: transcript }]
        });
        const reply = gptResponse.choices[0].message.content;

        const [ttsResponse] = await ttsClient.synthesizeSpeech({
            input: { text: reply },
            voice: { languageCode: 'tr-TR', name: 'tr-TR-Wavenet-E', ssmlGender: 'FEMALE' },
            audioConfig: { audioEncoding: 'MP3' }
        });

        fs.unlinkSync(req.file.path);
        res.json({ success: true, transcript, message: reply, audioBase64: ttsResponse.audioContent.toString('base64') });

    } catch (error) {
        if(req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, function() {
    console.log("\n===========================================");
    console.log("  NANOKAR AI BOT v2.2 (FULL SYSTEM)");
    console.log("===========================================");
    console.log("  Port: " + port);
    console.log("  Urunler: " + globalProductData.length);
    console.log("  Dil Destegi: AKTIF (TR -> EN)");
    console.log("  Prompt: " + (fs.existsSync('system_prompt.txt') ? "DOSYA" : "BACKUP"));
    console.log("===========================================\n");
});
