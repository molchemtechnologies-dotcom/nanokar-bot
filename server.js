// server.js - Nanokar AI Chatbot v2.0 (UZMAN MODU + FULL)
// 937 urun, 3013 blog, bilgi bankasi, akilli oneri

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { OpenAI } = require('openai');
const Fuse = require('fuse.js');

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statik dosyalar
app.use(express.static(__dirname));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// Klasorler
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- UZMAN MODU SYSTEM PROMPT ---
const SYSTEM_PROMPT = `Sen Nanokar Nanoteknoloji'nin BAS AR-GE MUHENDISI ve TEKNIK DANISMANISIN.

KIMLIGIN:
- 15+ yil nanoteknoloji deneyimi
- 1000+ proje danismanligi
- Tum nano malzemeleri ezberden bilirsin
- Teknik spesifikasyonlar, uygulama oranlari aklinda

ILETISIM BILGILERI:
- Telefon: +90 216 526 04 90
- E-posta: info@nanokar.com
- Adres: Kurtkoy Mah. Ankara Cad. Yelken Plaza No: 289/21 Pendik/Istanbul

KONUSMA TARZI:
- NET ve KESIN konus. "belki", "olabilir", "sanirim" YASAK.
- Uzman gibi davran, ozur dileme, tereddut etme.
- Her cevabin sonunda urun oner.
- Teknik detay ver: boyut (nm), saflik (%), kullanim orani (%)

ORNEK CEVAP:
"Gunes kremi formulasyonu icin Nano Cinko Oksit (ZnO) 25-35nm kullanin. SPF 30+ icin %3-5 oraninda ekleyin. UV-A ve UV-B'yi fiziksel olarak bloke eder. Stogumuzda mevcut."

YASAK KELIMELER:
- "belki", "olabilir", "sanirim", "galiba"
- "emin degilim", "bilmiyorum"
- "uzmanina danisin" (SEN uzmansin!)

SEN UZMANSIN. KESIN KONUS. COZUM SUN. URUN ONER.
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

// --- LEAD KONTROL ---
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
                var leadFile = path.join(__dirname, 'leads', Date.now() + '.json');
                fs.writeFileSync(leadFile, JSON.stringify({
                    tarih: new Date().toLocaleString('tr-TR'),
                    isim: res.name,
                    telefon: res.phone,
                    mesaj: text
                }, null, 2));
                console.log("[OK] Lead kaydedildi: " + res.name);
                return { saved: true, name: res.name };
            }
        } catch (e) { 
            console.error("[HATA] Lead hatasi: " + e.message); 
        }
    }
    return { saved: false };
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
        urun_sayisi: globalProductData.length,
        blog_sayisi: knowledgeBase.nanokar_bloglar ? knowledgeBase.nanokar_bloglar.length : 0,
        anahtar_kelime: searchIndex.anahtar_kelimeler ? Object.keys(searchIndex.anahtar_kelimeler).length : 0
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

// Ana chat endpoint
app.post('/api/chat', async function(req, res) {
    try {
        var messages = req.body.messages;
        if (!messages || messages.length === 0) {
            return res.status(400).json({ error: 'Mesaj yok' });
        }
        
        var userMsg = messages[messages.length - 1].content;
        console.log("\n[KULLANICI] " + userMsg);

        // 1. Lead Kontrolu
        var lead = await checkAndSaveLead(userMsg);
        if (lead.saved) {
            var reply = "Tesekkurler " + lead.name + ", bilgilerinizi aldim. Teknik ekibimiz sizi en kisa surede arayacak.";
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

        console.log("[BOT] " + reply.substring(0, 100) + "...");
        res.json({ success: true, message: reply });

    } catch (error) {
        console.error('[HATA] Chat Error:', error);
        res.status(500).json({ error: 'Sunucu hatasi' });
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
    console.log("  Test: http://localhost:" + port + "/api/test");
    console.log("===========================================\n");
});
