// server.js - Nanokar AI Chatbot (FİNAL SÜRÜM: Ses + Mail + Dosya Bazlı Arama)

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

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const upload = multer({ dest: 'uploads/' });

// --- GOOGLE CLOUD AYARLARI (Render Environment'tan Okur ve Dosya Yaratır) ---
// Bu kısım Render'a yapıştırdığınız JSON verisini alır ve sunucuda dosya haline getirir.
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    fs.writeFileSync('nanokar-key.json', process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = 'nanokar-key.json';
}

// Ses İstemcilerini Başlat
let speechClient, ttsClient;
try {
    speechClient = new SpeechClient();
    ttsClient = new TextToSpeechClient();
    console.log("✅ Ses servisleri aktif (Google Cloud).");
} catch (e) { console.log("⚠️ Ses servisi başlatılamadı (Anahtar eksik olabilir).", e.message); }

// Gerekli Klasörleri Oluştur
if (!fs.existsSync('leads')) fs.mkdirSync('leads');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// --- BOT KİMLİĞİ VE KURALLARI ---
const SYSTEM_PROMPT = `
Sen Nanokar Nanoteknoloji şirketinin yapay zeka satış asistanısın.
Şirket İletişim Bilgileri: 
- Telefon: +90 216 526 04 90
- E-posta: sales@nanokar.com
- Adres: Kurtköy, Pendik / İstanbul

KURALLAR:
1. Müşteri iletişim bilgisi sorarsa YUKARIDAKİ bilgileri ver.
2. Ürün stokta yoksa veya fiyat sorulursa: "Size özel fiyat çalışması yapabilmemiz için lütfen İsim, Soyisim ve Telefon numaranızı yazar mısınız?" de.
3. Müşteri iletişim bilgilerini verirse (örn: Sefer Baş 0546...), "Bilgilerinizi aldım, satış temsilcimiz en kısa sürede size ulaşacaktır." de.
`;

// --- ÜRÜN YÜKLEME (products.txt dosyasından) ---
let localProductList = [];
const productFilePath = path.join(__dirname, 'products.txt');

try {
    if (fs.existsSync(productFilePath)) {
        const data = fs.readFileSync(productFilePath, 'utf-8');
        // Boş satırları temizle ve listeye at
        localProductList = data.split('\n').map(line => line.trim()).filter(line => line.length > 0);
        console.log(`✅ Ürün listesi yüklendi: ${localProductList.length} adet ürün.`);
    } else {
        console.warn("⚠️ UYARI: products.txt dosyası bulunamadı! Ürün önerisi yapılamayacak.");
    }
} catch (err) { console.error("Dosya okuma hatası:", err); }

// Fuse.js ile Akıllı Arama (Hatalı yazımları düzeltir)
const fuse = new Fuse(localProductList.map(name => ({ name })), {
    keys: ['name'],
    includeScore: true,
    threshold: 0.4 // Hata toleransı (0.0 tam eşleşme, 1.0 her şey)
});

// --- MAİL GÖNDERME FONKSİYONU (Güvenli) ---
async function sendLeadEmail(name, phone, message) {
    // Render Environment Variables üzerinden bilgileri alır
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.log("⚠️ Mail gönderilemedi: EMAIL_USER veya EMAIL_PASS ayarlanmamış.");
        return;
    }

    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER, // Render'dan gelecek
            pass: process.env.EMAIL_PASS  // Render'dan gelecek
        }
    });

    const mailOptions = {
        from: 'Nanokar AI Asistan',
        to: 'sales@nanokar.com', // Bildirimin gideceği asıl adres (veya kendiniz)
        subject: '🔔 Yeni Müşteri Talebi (Chatbot)',
        text: `Yeni bir potansiyel müşteri (Lead) yakalandı!\n\n👤 İsim: ${name}\n📞 Telefon: ${phone}\n💬 Mesaj: ${message}\n\n📅 Tarih: ${new Date().toLocaleString('tr-TR')}`
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("📧 Lead maili başarıyla gönderildi.");
    } catch (error) {
        console.error("❌ Mail gönderme hatası:", error);
    }
}

// --- LEAD (MÜŞTERİ) YAKALAMA VE KAYDETME ---
async function checkAndSaveLead(text) {
    // Basit telefon numarası kontrolü (05xx... veya 5xx...)
    if (text.match(/(\+90|0)?\s*5\d{2}/)) {
        try {
            // OpenAI ile isim ve numarayı ayıkla
            const response = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: 'Metinden İSİM ve TELEFON numarasını JSON formatında çıkar: {"found": true, "name": "...", "phone": "..."}. Eğer bulamazsan {"found": false} döndür.' },
                    { role: 'user', content: text }
                ],
                response_format: { type: "json_object" }
            });
            
            const result = JSON.parse(response.choices[0].message.content);
            
            if (result.found) {
                // Dosyaya Kaydet (Admin paneli için)
                const logEntry = `TARİH: ${new Date().toLocaleString('tr-TR')}\nİSİM: ${result.name}\nTEL: ${result.phone}\nMESAJ: ${text}\n-----------------------------------\n`;
                fs.appendFileSync(path.join(__dirname, 'leads', 'Musteri_Talepleri.txt'), logEntry);
                
                // Mail Gönder
                sendLeadEmail(result.name, result.phone, text);

                return { saved: true, name: result.name };
            }
        } catch (e) { 
            console.error("Lead analiz hatası:", e);
        }
    }
    return { saved: false };
}

// --- API ENDPOINTS ---

// 1. Admin Paneli (Müşteri Listesi)
app.get('/admin-leads', (req, res) => {
    const filePath = path.join(__dirname, 'leads', 'Musteri_Talepleri.txt');
    let content = 'Henüz kayıt yok.';
    
    if (fs.existsSync(filePath)) {
        content = fs.readFileSync(filePath, 'utf-8');
    }
    
    res.send(`
        <html>
        <head><title>Nanokar Müşteri Talepleri</title><meta charset="utf-8"></head>
        <body style="font-family:Arial; padding:20px; background:#f4f4f9;">
            <h1 style="color:#1e3c72;">📋 Müşteri İletişim Talepleri</h1>
            <a href="javascript:location.reload()" style="background:#1e3c72;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Sayfayı Yenile</a>
            <pre style="background:white; padding:20px; border-radius:8px; margin-top:20px; white-space:pre-wrap; border:1px solid #ddd;">${content}</pre>
        </body>
        </html>
    `);
});

// Widget Dosyasını Sunma
app.get('/widget', (req, res) => {
    res.send("Chatbot sunucusu aktif. Lütfen WordPress eklentisini kullanın.");
});

// 2. Chat API (Metin)
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        if (!messages || messages.length === 0) return res.status(400).json({ error: "Mesaj yok" });
        
        const lastUserMessage = messages[messages.length - 1].content;

        // A. Lead Kontrolü
        const leadResult = await checkAndSaveLead(lastUserMessage);
        if (leadResult.saved) {
            return res.json({ 
                success: true, 
                message: `Bilgilerinizi aldım ${leadResult.name}. Satış temsilcimiz en kısa sürede size dönüş yapacaktır.` 
            });
        }

        // B. Ürün Arama
        const searchResult = fuse.search(lastUserMessage);
        let productInfo = "";
        
        if (searchResult.length > 0) {
            const topProducts = searchResult.slice(0, 3).map(r => r.item.name);
            const productLinks = topProducts.map(name => {
                const link = `https://www.nanokar.com.tr/kategori?ara=${encodeURIComponent(name)}`;
                return `🔹 <a href="${link}" target="_blank" style="color:#0056b3;font-weight:bold;">${name}</a>`;
            }).join('<br>');
            
            productInfo = `\n\nStoklarımızda şunlar mevcut olabilir:\n${productLinks}\nDetaylar için ürün isimlerine tıklayabilirsiniz.`;
        }

        // C. AI Yanıtı Üretme
        const gpt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                ...messages
            ]
        });

        let botMessage = gpt.choices[0].message.content;
        
        // Ürün varsa mesajın sonuna ekle
        if (productInfo && !botMessage.includes('http')) {
            botMessage += "<br>" + productInfo;
        }

        res.json({ success: true, message: botMessage });

    } catch (error) {
        console.error("Chat Error:", error);
        res.status(500).json({ success: false, error: 'Sunucu hatası.' });
    }
});

// 3. Sesli Asistan API
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Ses dosyası yok' });

    try {
        const audioBytes = await fs.promises.readFile(req.file.path);
        
        // STT: Sesi Metne Çevir
        const [sttResponse] = await speechClient.recognize({
            config: { languageCodes: ['tr-TR'], encoding: 'WEBM_OPUS' },
            audio: { content: audioBytes.toString('base64') }
        });
        
        const transcript = sttResponse.results.map(r => r.alternatives[0].transcript).join('\n');
        if (!transcript) throw new Error('Ses anlaşılamadı');

        // AI Cevabı Al
        const gpt = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [
                { role: 'system', content: SYSTEM_PROMPT + " Cevabın kısa ve konuşma diline uygun olsun." },
                { role: 'user', content: transcript }
            ]
        });
        const replyText = gpt.choices[0].message.content;

        // TTS: Cevabı Sese Çevir
        const [ttsResponse] = await ttsClient.synthesizeSpeech({
            input: { text: replyText },
            voice: { languageCode: 'tr-TR', ssmlGender: 'NEUTRAL' },
            audioConfig: { audioEncoding: 'MP3' },
        });

        res.json({
            success: true,
            message: replyText,
            audioBase64: ttsResponse.audioContent.toString('base64')
        });

    } catch (error) {
        console.error('Voice Error:', error);
        res.status(500).json({ error: 'Ses işlenemedi.' });
    } finally {
        // Geçici dosyayı sil
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
});

app.listen(port, () => console.log(`Sunucu ${port} portunda aktif.`));
