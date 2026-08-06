require('dotenv').config();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const AdmZip = require('adm-zip');

// ==========================================
// ГЛОБАЛЬНЫЕ ПЕРЕХВАТЧИКИ ПАДЕНИЙ (Anti-Crash)
// ==========================================
process.on('uncaughtException', (err) => {
    console.error('❌ [ANTI-CRASH] Неперехваченная ошибка системы:', err.message);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [ANTI-CRASH] Необработанный Promise:', reason);
});

const TARGET_PHONE = (process.env.TARGET_PHONE || '905394884031').replace(/[^0-9]/g, '');
const SPREADSHEET_ID = (process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '').trim();
const MEDIA_FOLDER_ID = (process.env.GOOGLE_DRIVE_MEDIA_FOLDER_ID || '').trim();
const IMPORT_FOLDER_ID = (process.env.GOOGLE_DRIVE_IMPORT_FOLDER_ID || '1Vui_1npdrfwc7fZqGLlBYB__I98TUD2W').trim();

console.log('==========================================');
console.log('🔍 [Config] Проверка переменных окружения:');
console.log(`- TARGET_PHONE: ${TARGET_PHONE}`);
console.log(`- SPREADSHEET_ID: ${SPREADSHEET_ID ? 'Задан' : 'ОТСУТСТВУЕТ'}`);
console.log(`- MEDIA_FOLDER_ID: ${MEDIA_FOLDER_ID ? 'Задан' : 'ОТСУТСТВУЕТ'}`);
console.log(`- IMPORT_FOLDER_ID: ${IMPORT_FOLDER_ID}`);
console.log('==========================================');

let sheets = null;
let drive = null;
let isHistoryLoaded = false;
let historySynced = false;
let globalSheetName = 'Переписка WhatsApp';

let targetIdsArray = [`${TARGET_PHONE}@c.us`, TARGET_PHONE];
let globalLid = 'N/A';
let globalCUs = `${TARGET_PHONE}@c.us`;
let globalContactName = 'Контакт (Синхронизация...)';
let isImporting = false; 

// 1. Инициализация Google API
if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL.trim(),
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive'
      ],
    });
    sheets = google.sheets({ version: 'v4', auth });
    drive = google.drive({ version: 'v3', auth });
    console.log('✅ Инициализация Google API прошла успешно.');
  } catch (err) {
    console.error('❌ Ошибка авторизации Google API:', err.message);
  }
}

// 2. Форматирование 13-колоночной таблицы
async function verifyAndFormatGoogleInfrastructure() {
  if (!SPREADSHEET_ID || !MEDIA_FOLDER_ID) return;
  try {
    const sheetMeta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetId = sheetMeta.data.sheets[0].properties.sheetId;
    
    const requests = [
      {
        updateSheetProperties: {
          properties: { sheetId: sheetId, title: globalSheetName, gridProperties: { frozenRowCount: 1 } },
          fields: 'title,gridProperties.frozenRowCount'
        }
      },
      {
        repeatCell: {
          range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
              textFormat: { bold: true, fontSize: 11 },
              wrapStrategy: 'WRAP', horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE'
            }
          }, fields: 'userEnteredFormat(backgroundColor,textFormat,wrapStrategy,horizontalAlignment,verticalAlignment)'
        }
      },
      {
        repeatCell: {
          range: { sheetId: sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 13 },
          cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } },
          fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)'
        }
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 },
          properties: { pixelSize: 150 }, fields: 'pixelSize'
        }
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 5 },
          properties: { pixelSize: 300 }, fields: 'pixelSize'
        }
      },
      {
        updateDimensionProperties: {
          range: { sheetId: sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 13 },
          properties: { pixelSize: 140 }, fields: 'pixelSize'
        }
      },
      {
        setDataValidation: {
          range: { sheetId: sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: [
                { userEnteredValue: '1 - Перевод выключен' },
                { userEnteredValue: '2 - Авто перевод на турецкий' },
                { userEnteredValue: '3 - Авто перевод на русский' },
                { userEnteredValue: '4 - Авто перевод на английский' }
              ]
            }, showCustomUi: true, strict: true
          }
        }
      }
    ];

    await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests } });

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!A1:M1`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[
          'Дата и время', 'Отправитель', 'Сообщение (Входящее / Мой ответ)', 'Перевод (Из чата)', '2 - Авто перевод на турецкий',
          'Вложение (Входящее)', 'Вложение (Исходящее)', 'Статус входящие из чата', 'Статус отправки', 
          'ID (Перехват)', 'ID (LID)', 'ID (C.US)', 'ID (Номер)'
        ]]
      }
    });
    console.log('✅ Форматирование CRM-таблицы готово!');
  } catch (err) {
    console.error('❌ Ошибка форматирования:', err.message);
  }
}

// 3. Передача прав владельца
async function transferOwnership(fileId) {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) return;
  try {
    await drive.permissions.create({
      fileId: fileId, transferOwnership: true, supportsAllDrives: true,
      requestBody: { role: 'owner', type: 'user', emailAddress: ownerEmail.trim() }
    });
  } catch (err) {}
}

// 4. Безопасный потоковый загрузчик файлов
async function uploadMediaToDrive(filename, mimeType, base64Data) {
  if (!drive || !MEDIA_FOLDER_ID) return '';
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const bufferStream = Readable.from(buffer);
    const file = await drive.files.create({
      requestBody: { name: filename, parents: [MEDIA_FOLDER_ID] },
      media: { mimeType: mimeType, body: bufferStream },
      fields: 'id, webViewLink', supportsAllDrives: true 
    });
    await transferOwnership(file.data.id);
    return file.data.webViewLink || '';
  } catch (err) {
    console.error('❌ Ошибка загрузки медиа GD:', err.message);
    return 'Ошибка загрузки GD';
  }
}

// 5. Дедупликация
async function getExistingRowSignatures() {
  const signatures = new Set();
  if (!SPREADSHEET_ID || !sheets) return signatures;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!A:C` });
    if (res.data.values) {
      for (const row of res.data.values) {
        if (row.length >= 3) signatures.add(`${row[0]}_${row[1]}_${row[2]}`);
      }
    }
  } catch (err) {}
  return signatures;
}

// 6. Чтение ID из таблицы
async function getSavedChatIdsFromSheet() {
  const ids = new Set();
  if (!SPREADSHEET_ID || !sheets) return Array.from(ids);
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!J:M` });
    if (res.data.values) {
      for (const row of res.data.values) {
        row.forEach(val => {
          if (val && typeof val === 'string' && (val.includes('@') || /^\d+$/.test(val))) ids.add(val.trim());
        });
      }
    }
  } catch (err) {}
  return Array.from(ids);
}

// 7. Запись сообщений в Таблицу
async function appendMessageToGoogleSheet(messageBody, senderName, fileUrl, originalFilename, customTimestamp, realChatId) {
  if (!SPREADSHEET_ID || !sheets) return;
  try {
    const timestamp = customTimestamp || new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Istanbul' });
    let fileHyperlink = '';
    if (fileUrl && fileUrl.startsWith('http')) {
      const safeName = originalFilename ? originalFilename.replace(/"/g, '') : 'Скачать файл';
      fileHyperlink = `=HYPERLINK("${fileUrl}"; "💾 ${safeName}")`;
    } else if (fileUrl) {
      fileHyperlink = fileUrl; 
    }

    const formulaIncomingTranslate = `=IF(OR(ISBLANK(INDIRECT("C" & ROW())); INDIRECT("H" & ROW())<>"Обработано"); ""; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "ru"))`;
    const formulaOutgoingTranslate = `=IF(OR(ISBLANK(INDIRECT("C" & ROW())); INDIRECT("H" & ROW())="Обработано"); ""; IF(LEFT($E$1; 1)="1"; INDIRECT("C" & ROW()); IF(LEFT($E$1; 1)="2"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "tr"); IF(LEFT($E$1; 1)="3"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "ru"); IF(LEFT($E$1; 1)="4"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "en"); INDIRECT("C" & ROW()))))))`;

    const rowValues = [
      timestamp, senderName, messageBody || (fileUrl && !fileUrl.includes('Ошибка') && !fileUrl.includes('Медиа') ? '[Вложение]' : ''),
      formulaIncomingTranslate, formulaOutgoingTranslate, fileHyperlink, '', 'Обработано', '',
      realChatId || 'Системный перехват', globalLid, globalCUs, TARGET_PHONE
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!A:M`,
      valueInputOption: 'USER_ENTERED', requestBody: { values: [rowValues] },
    });
    console.log(`📊 [${timestamp}] Запись (${senderName}): Текст успешно зафиксирован.`);
  } catch (err) {
    console.error('❌ Ошибка записи в таблицу:', err.message);
  }
}

// 8. УСИЛЕННЫЙ СКАЧИВАТЕЛЬ МЕДИА
async function robustDownloadMedia(msg) {
  const validMediaTypes = ['image', 'video', 'document', 'audio', 'ptt', 'sticker'];
  if (!msg.hasMedia || !validMediaTypes.includes(msg.type)) return null;
  console.log(`📥 [Медиа] Обнаружен файл: ${msg.type}.`);
  
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const media = await msg.downloadMedia();
      if (media && media.data) {
        console.log(`✅ [Медиа] Файл загружен (Попытка ${attempt}/8).`);
        return media;
      }
    } catch (err) {
      console.warn(`⚠️ [Медиа] Ошибка расшифровки (Попытка ${attempt}/8): ${err.message}`);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  return null;
}

// ==========================================
// РЕКУРСИВНЫЙ ПОИСК ФАЙЛОВ
// ==========================================
function findFileRecursively(dir, isTxt = true) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            results = results.concat(findFileRecursively(fullPath, isTxt));
        } else {
            if (isTxt && file.endsWith('.txt')) results.push(fullPath);
            if (!isTxt && !file.endsWith('.txt')) results.push(fullPath);
        }
    }
    return results;
}

// ==========================================
// БЛОК ЛОКАЛЬНОЙ БД (ANTI-LOOP СИСТЕМА)
// ==========================================
const PROCESSED_DB_PATH = path.join(__dirname, 'processed_db.json');

function getProcessedDriveFiles() {
    if (fs.existsSync(PROCESSED_DB_PATH)) {
        try { return JSON.parse(fs.readFileSync(PROCESSED_DB_PATH, 'utf8')); } catch (e) { return []; }
    }
    return [];
}

function markDriveFileAsProcessed(fileId) {
    const list = getProcessedDriveFiles();
    if (!list.includes(fileId)) {
        list.push(fileId);
        fs.writeFileSync(PROCESSED_DB_PATH, JSON.stringify(list));
    }
}

// 9. АВТОМАТИЧЕСКИЙ ПАРСЕР ИЗ GOOGLE DRIVE (С ДЕДУПЛИКАЦИЕЙ И ТОЧНЫМ ПОИСКОМ МЕДИА)
async function processDriveImports() {
  if (!IMPORT_FOLDER_ID || isImporting || !drive) return;
  
  try {
    const res = await drive.files.list({
      q: `'${IMPORT_FOLDER_ID}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType)',
      corpora: 'allDrives',
      supportsAllDrives: true, 
      includeItemsFromAllDrives: true
    });
    
    const allFiles = res.data.files || [];
    if (allFiles.length === 0) return;

    const processedList = getProcessedDriveFiles();
    
    const files = allFiles.filter(f => 
        !processedList.includes(f.id) &&
        !f.name.includes('[ОБРАБОТАНО]') &&
        (f.name.toLowerCase().endsWith('.zip') || f.mimeType === 'application/zip' || f.name.toLowerCase().endsWith('.txt'))
    );
    
    if (files.length === 0) return;

    isImporting = true;
    for (const file of files) {
      console.log(`\n📦 [Импорт] Начинаем обработку нового файла: ${file.name}`);
      
      const isDirectTxt = file.name.toLowerCase().endsWith('.txt');
      const destFile = path.join(__dirname, file.name);
      const extractDir = path.join(__dirname, `temp_extract_${Date.now()}`);
      
      const response = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
      
      await new Promise((resolve, reject) => {
         const ws = fs.createWriteStream(destFile);
         response.data.pipe(ws).on('finish', resolve).on('error', reject);
      });
      console.log(`✅ [Импорт] Файл скачан на сервер.`);

      let txtFiles = [];
      let allMediaFiles = [];

      if (!isDirectTxt) {
          try {
              const zip = new AdmZip(destFile);
              zip.extractAllTo(extractDir, true);
              txtFiles = findFileRecursively(extractDir, true);
              allMediaFiles = findFileRecursively(extractDir, false);
          } catch (zipErr) {
              console.error(`❌ [ZIP Импорт] Ошибка при распаковке архива:`, zipErr.message);
              markDriveFileAsProcessed(file.id);
              fs.unlinkSync(destFile);
              continue;
          }
      } else {
          txtFiles = [destFile];
      }
      
      if (txtFiles.length === 0) {
         console.warn(`⚠️ [Импорт] Файл истории (.txt) не найден.`);
         if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
         if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
         markDriveFileAsProcessed(file.id);
         continue;
      }

      const txtContent = fs.readFileSync(txtFiles[0], 'utf8');
      const lines = txtContent.split('\n');
      const regex = /^(\d{2}\.\d{2}\.\d{2,4}),?\s(\d{2}:\d{2})\s-\s(.*?):\s(.*)$/;
      const records = []; let currentMsg = null;

      for (let line of lines) {
        line = line.replace('\r', '');
        if (line.trim() === '') continue;
        const match = line.match(regex);
        if (match) {
          if (currentMsg) records.push(currentMsg);
          currentMsg = { timestamp: `${match[1]}, ${match[2]}`, sender: match[3], text: match[4] };
        } else if (currentMsg) {
          currentMsg.text += '\n' + line;
        }
      }
      if (currentMsg) records.push(currentMsg);
      console.log(`✅ [Импорт] Распознано ${records.length} сообщений.`);

      const existingSignatures = await getExistingRowSignatures();
      const rowsToInsert = []; let addedCount = 0;

      for (const msg of records) {
         if (msg.text.includes('сообщения и звонки защищены сквозным шифрованием')) continue;
         
         let fileHyperlink = ''; let messageBody = msg.text;
         
         // ИСПРАВЛЕННЫЙ ПОИСК МЕДИА: Очищаем невидимые символы WhatsApp LRM (U+200E) 
         // И ищем совпадение как с расширением, так и без него.
         const cleanMsgText = msg.text.replace(/[\u200E\u200F\u202A\u202B\u202C\u202D\u202E]/g, '');
         
         const attachedFilePath = allMediaFiles.find(fullPath => {
             const baseName = path.basename(fullPath);
             const nameWithoutExt = path.parse(fullPath).name;
             return cleanMsgText.includes(baseName) || cleanMsgText.includes(nameWithoutExt);
         });
         
         if (attachedFilePath) {
             const baseName = path.basename(attachedFilePath);
             try {
                 // ИСПРАВЛЕННЫЙ ЗАГРУЗЧИК (Добавлен mimeType: application/octet-stream)
                 const fileBuffer = fs.readFileSync(attachedFilePath);
                 const bufferStream = Readable.from(fileBuffer);
                 
                 const uploadedFile = await drive.files.create({
                    requestBody: { name: baseName, parents: [MEDIA_FOLDER_ID] },
                    media: { mimeType: 'application/octet-stream', body: bufferStream },
                    fields: 'id, webViewLink', supportsAllDrives: true 
                 });
                 await transferOwnership(uploadedFile.data.id);
                 
                 const safeName = baseName.replace(/"/g, '');
                 fileHyperlink = `=HYPERLINK("${uploadedFile.data.webViewLink}"; "💾 ${safeName}")`;
                 messageBody = '[Вложение из архива]';
                 console.log(`📤 [ZIP Импорт] Файл ${baseName} успешно загружен на Диск.`);
             } catch (e) { 
                 console.error(`❌ [ZIP Импорт] Ошибка загрузки файла ${baseName}:`, e.message);
                 fileHyperlink = '⚠️ Ошибка загрузки из архива'; 
             }
         } else if (messageBody.includes('<Прикрепленный файл отсутствует>') || messageBody.includes('(файл прикреплен)') || messageBody.includes('(файл добавлен)')) {
             fileHyperlink = '⚠️ Файл не найден в архиве';
             messageBody = '[Вложение]';
         }

         const sig = `${msg.timestamp}_${msg.sender}_${messageBody}`;
         if (existingSignatures.has(sig)) continue; 

         const formulaIncomingTranslate = `=IF(OR(ISBLANK(INDIRECT("C" & ROW())); INDIRECT("H" & ROW())<>"Обработано"); ""; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "ru"))`;
         const formulaOutgoingTranslate = `=IF(OR(ISBLANK(INDIRECT("C" & ROW())); INDIRECT("H" & ROW())="Обработано"); ""; IF(LEFT($E$1; 1)="1"; INDIRECT("C" & ROW()); IF(LEFT($E$1; 1)="2"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "tr"); IF(LEFT($E$1; 1)="3"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "ru"); IF(LEFT($E$1; 1)="4"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "en"); INDIRECT("C" & ROW()))))))`;

         rowsToInsert.push([
            msg.timestamp, msg.sender, messageBody,
            formulaIncomingTranslate, formulaOutgoingTranslate, fileHyperlink,
            '', 'Обработано', '', 'Архивный Импорт', globalLid, globalCUs, TARGET_PHONE
         ]);
         addedCount++;
         existingSignatures.add(sig); 
      }

      if (rowsToInsert.length > 0) {
          console.log(`📤 [Импорт] Отправка ${addedCount} новых строк в Google Таблицу...`);
          const chunkSize = 500;
          for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
              const chunk = rowsToInsert.slice(i, i + chunkSize);
              await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!A:M`,
                valueInputOption: 'USER_ENTERED', requestBody: { values: chunk },
              });
          }
          console.log(`🎉 [Импорт] Успех! Загружено ${addedCount} сообщений.`);
      } else {
          console.log(`ℹ️ [Импорт] Новых сообщений не найдено (дубликаты отброшены).`);
      }

      markDriveFileAsProcessed(file.id);

      if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
      
      try {
          await drive.files.update({ fileId: file.id, requestBody: { trashed: true } });
          console.log(`🗑️ [Импорт] Обработанный файл перемещен в Корзину Диска.`);
      } catch (trashErr) {
          console.warn(`⚠️ [Импорт] У бота нет прав владельца на удаление. Пробуем переименовать...`);
          try {
              await drive.files.update({ fileId: file.id, requestBody: { name: '[ОБРАБОТАНО] ' + file.name } });
              console.log(`🏷️ [Импорт] Файл успешно переименован.`);
          } catch(renameErr) {}
      }
    }
  } catch (err) {
    console.error('❌ [Импорт] Системная ошибка:', err.message);
  } finally {
    isImporting = false;
  }
}

// 10. БЛОК КОНТРОЛЯ КРИПТО-СИНХРОНИЗАЦИИ
async function waitForCryptoSync() {
  console.log('🔄 [Крипто-Синхронизация] Проверка статуса фоновой синхронизации ключей Meta...');
  let isSyncing = true; let attempts = 0;
  while (isSyncing && attempts < 12) {
    try {
      const state = await client.pupPage.evaluate(() => {
        if (window.Store && window.Store.State) return window.Store.State.default.state;
        return null;
      });
      if (state === 'CONNECTED' || state === 'TIMEOUT') {
        isSyncing = false;
        console.log(`✅ [Крипто-Синхронизация] Фоновая синхронизация завершена.`);
      } else {
        console.log(`⏳ [Крипто-Синхронизация] Ожидание 5 секунд...`);
        await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
    attempts++;
  }
}

// 11. Склеенная выгрузка истории
async function syncMergedChatHistory(liveChatFallback = null) {
  if (historySynced) return;
  try {
    console.log(`🔄 Инициирован склеенный захват истории...`);
    let mergedMessages = []; let chatsToProcess = [];

    for (const id of targetIdsArray) {
      const c = await client.getChatById(id).catch(() => null);
      if (c) chatsToProcess.push(c);
    }
    if (chatsToProcess.length === 0 && liveChatFallback) chatsToProcess.push(liveChatFallback);
    if (chatsToProcess.length === 0) return;

    await waitForCryptoSync();

    for (const chatObj of chatsToProcess) {
      try {
        await client.pupPage.evaluate(async (chatId) => {
          if (window.Store && window.Store.Chat && window.Store.ChatFetcher) {
            const c = window.Store.Chat.get(chatId);
            if (c) await window.Store.ChatFetcher.loadEarlierMessages(c);
          }
        }, chatObj.id._serialized);
        await new Promise(r => setTimeout(r, 4000));
      } catch (syncErr) {}

      const msgs = await chatObj.fetchMessages({ limit: 300 }).catch(() => []);
      mergedMessages.push(...msgs);
    }

    if (mergedMessages.length > 0) {
      const uniqueMessages = Array.from(new Map(mergedMessages.map(item => [item.id._serialized, item])).values());
      uniqueMessages.sort((a, b) => a.timestamp - b.timestamp);
      
      const existingSignatures = await getExistingRowSignatures();
      let restoredCount = 0;

      for (const msg of uniqueMessages) {
        const timestamp = new Date(msg.timestamp * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Istanbul' });
        let senderName = globalContactName;
        if (msg.fromMe) senderName = 'Алексей Знаменский';
        else {
            const msgContact = await msg.getContact().catch(() => null);
            if (msgContact && (msgContact.name || msgContact.pushname)) senderName = msgContact.name || msgContact.pushname;
        }
        const textContent = msg.body || '';
        const sig = `${timestamp}_${senderName}_${textContent}`;

        if (!existingSignatures.has(sig)) {
          let fileUrl = ''; let originalFilename = '';
          if (msg.hasMedia) {
            const media = await robustDownloadMedia(msg);
            if (media && media.data) {
              const ext = media.mimetype ? media.mimetype.split(';')[0].split('/')[1] : 'bin';
              let nameWithoutExt = media.filename ? media.filename.substring(0, media.filename.lastIndexOf('.')) || media.filename : 'Media';
              originalFilename = `${nameWithoutExt}_${Date.now()}.${ext}`;
              fileUrl = await uploadMediaToDrive(originalFilename, media.mimetype, media.data);
            }
          }
          const realId = msg.fromMe ? msg.to : msg.from;
          await appendMessageToGoogleSheet(textContent, senderName, fileUrl, originalFilename, timestamp, realId);
          existingSignatures.add(sig);
          restoredCount++;
        }
      }
      console.log(`✅ Склеенная история успешно извлечена! Записано: ${restoredCount}`);
      historySynced = true;
    }
  } catch (err) {}
}

// 12. ПОЛНЫЙ 8-УРОВНЕВЫЙ КАСКАДНЫЙ ПОИСК
async function restoreChatHistoryAndStartLive() {
  let targetChat = null;

  try {
    console.log(`🔄 Инициализация 8-уровневого поиска чата...`);
    
    console.log(`\n[УРОВЕНЬ 6] Чтение сохраненных ID из Google Таблицы...`);
    const sheetIds = await getSavedChatIdsFromSheet();
    if (sheetIds.length > 0) {
      console.log(`✅ Найдена база подтвержденных ID: ${sheetIds.join(', ')}`);
      targetIdsArray.push(...sheetIds);
    } else {
      console.log(`⚠️ [Уровень 6] Таблица пуста, нет сохраненных ID.`);
    }

    console.log('⏳ Ожидание базовой загрузки RAM WhatsApp (15 секунд)...');
    await new Promise(resolve => setTimeout(resolve, 15000));

    for (let attempt = 1; attempt <= 3; attempt++) {
      console.log(`\n[Попытка ${attempt}/3] Запуск поиска и пробоя Lazy Load...`);
      try {
        const numberDetails = await client.getNumberId(TARGET_PHONE).catch(() => null);

        if (numberDetails && numberDetails._serialized) {
          targetIdsArray.push(numberDetails._serialized);
          if (numberDetails._serialized.includes('@lid')) {
            globalLid = numberDetails._serialized;
            globalCUs = `${numberDetails.user}@c.us`;
            targetIdsArray.push(globalCUs);
            console.log(`✅ Бизнес-аккаунт: LID = ${globalLid} | C.US = ${globalCUs}`);
          } else {
            globalCUs = numberDetails._serialized;
          }
        }
        targetIdsArray = [...new Set(targetIdsArray)];

        // [УРОВЕНЬ 8]: Ghost Ping
        console.log(`⚠️ [Уровень 8] Инициируем Ghost Ping (Скрытый пинг)...`);
        for (const id of targetIdsArray) {
          try {
            await client.sendSeen(id);
            await new Promise(r => setTimeout(r, 1000));
            console.log(`✅ [Уровень 8] Пинг отправлен для ${id}`);
          } catch (e) {
            console.log(`⚠️ [Уровень 8] Пинг отклонен для ${id}`);
          } 
        }

        // [УРОВЕНЬ 1]: Прямой поиск
        for (const id of targetIdsArray) {
          if (!targetChat) {
            console.log(`🔍 [Уровень 1] Запрос к RAM по ID: ${id}`);
            targetChat = await client.getChatById(id).catch(() => null);
            if (!targetChat) console.log(`⚠️ [Уровень 1] RAM вернула пустоту для ID: ${id}. Чат выгружен системой Lazy Load.`);
            else console.log(`✅ [Уровень 1] Чат найден в оперативной памяти!`);
          }
        }

        // [УРОВЕНЬ 2]: Контакты + ЗАХВАТ ИМЕНИ
        if (!targetChat) {
          console.log(`⚠️ [Уровень 2] Сканируем Контакты телефона...`);
          const contacts = await client.getContacts().catch(() => []);
          const targetContact = contacts.find(c => targetIdsArray.includes(c.id && c.id._serialized) || c.number === TARGET_PHONE);

          if (targetContact) {
            globalContactName = targetContact.name || targetContact.pushname || globalContactName;
            console.log(`✅ [Уровень 2] Контакт найден: ${globalContactName}. Извлекаем чат...`);
            targetChat = await targetContact.getChat().catch(() => null);
            if (!targetChat) console.log(`⚠️ [Уровень 2] Объект чата заблокирован криптографией.`);
            else console.log(`✅ [Уровень 2] Чат успешно извлечен из Контакта!`);
          } else {
            console.log(`⚠️ [Уровень 2] Контакт не найден в записной книжке.`);
          }
        }

        // [УРОВЕНЬ 3]: Диалоги
        if (!targetChat) {
          console.log(`⚠️ [Уровень 3] Сканирование массива всех активных диалогов...`);
          const allChats = await client.getChats().catch(() => []);
          targetChat = allChats.find(c => 
            (c.id && targetIdsArray.includes(c.id._serialized)) || 
            (c.id && targetIdsArray.includes(c.id.user))
          );
          if (!targetChat) console.log(`⚠️ [Уровень 3] Совпадений по целевым ID не найдено.`);
          else console.log(`✅ [Уровень 3] Чат найден в массиве диалогов!`);
        }

        // [УРОВЕНЬ 4]: Store.Chat.find
        if (!targetChat) {
          console.log(`⚠️ [Уровень 4] Инициируем ПРОБОЙ кэша ядра (Store.Chat.find)...`);
          for (const id of targetIdsArray) {
            try {
              await client.pupPage.evaluate(async (chatId) => {
                if (window.Store && window.Store.Chat) await window.Store.Chat.find(chatId);
              }, id);
              targetChat = await client.getChatById(id).catch(() => null);
              if (targetChat) {
                console.log(`✅ [Уровень 4] ПРОБОЙ УСПЕШЕН! Чат поднят в RAM.`);
                break;
              } else {
                 console.log(`⚠️ [Уровень 4] Инъекция для ${id} завершилась неудачей.`);
              }
            } catch (err) {
               console.log(`⚠️ [Уровень 4] Ошибка инъекции: ${err.message}`);
            }
          }
        }

        // [УРОВЕНЬ 5]: Store.Msg
        if (!targetChat) {
          console.log(`⚠️ [Уровень 5] Якорный пробой базы сообщений (Store.Msg)...`);
          try {
            const anchorMsgId = await client.pupPage.evaluate((ids) => {
              if (window.Store && window.Store.Msg) {
                const msgs = window.Store.Msg.getModelsArray();
                for (let i = msgs.length - 1; i >= 0; i--) {
                  let m = msgs[i];
                  if (m.from && ids.includes(m.from.toString())) return m.id._serialized;
                  if (m.to && ids.includes(m.to.toString())) return m.id._serialized;
                }
              }
              return null;
            }, targetIdsArray);

            if (anchorMsgId) {
              const anchorMsg = await client.getMessageById(anchorMsgId).catch(() => null);
              if (anchorMsg) targetChat = await anchorMsg.getChat().catch(() => null);
              if (targetChat) console.log(`✅ [Уровень 5] ПРОБОЙ УСПЕШЕН через якорь сообщения!`);
            } else {
              console.log(`⚠️ [Уровень 5] В базе Store.Msg нет сообщений от/для этого ID.`);
            }
          } catch (err) {
            console.log(`⚠️ [Уровень 5] Ошибка сканирования сообщений: ${err.message}`);
          }
        }

        // [УРОВЕНЬ 7]: Серверная синхронизация
        if (!targetChat) {
          console.log(`⚠️ [Уровень 7] Форсированная серверная синхронизация (loadEarlierMessages)...`);
          for (const id of targetIdsArray) {
            try {
              await client.pupPage.evaluate(async (chatId) => {
                if (window.Store && window.Store.Chat && window.Store.ChatFetcher) {
                   let chat = window.Store.Chat.get(chatId);
                   if (chat) await window.Store.ChatFetcher.loadEarlierMessages(chat);
                }
              }, id);
              targetChat = await client.getChatById(id).catch(() => null);
              if (targetChat) {
                 console.log(`✅ [Уровень 7] Серверная синхронизация прошла успешно!`);
                 break;
              } else {
                 console.log(`⚠️ [Уровень 7] Сервер WhatsApp проигнорировал команду для ${id}.`);
              }
            } catch (err) {
                 console.log(`⚠️ [Уровень 7] Сбой инъекции синхронизации: ${err.message}`);
            }
          }
        }

        if (targetChat) {
          console.log(`✅ Чат УСПЕШНО привязан! (ID: ${targetChat.id._serialized})`);
          break;
        }
      } catch (err) {
        console.warn(`⚠️ Ошибка поиска на попытке ${attempt}:`, err.message || err);
      }
      await new Promise(r => setTimeout(r, 10000));
    }

    if (targetChat) {
      await syncMergedChatHistory(); 
    } else {
      console.warn(`⚠️ ВНИМАНИЕ: Все 8 уровней пробоя завершились неудачей. Чат жестко изолирован.`);
      console.warn(`⚠️ Бот выгрузит историю автоматически при первом же живом сообщении.`);
    }
  } catch (err) {
    console.error('❌ Ошибка блока синхронизации:', err.message);
  } finally {
    isHistoryLoaded = true;
    console.log('📡 Бот перешел в режим отслеживания новых сообщений в реальном времени (24/7)...');
  }
}

// 13. CRM: Отправка сообщений из Таблицы
async function listenForRepliesFromSheet() {
  if (!isHistoryLoaded || !SPREADSHEET_ID || !sheets) return;
  try {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!A:I` });
    if (!res.data.values) return;

    for (let i = 1; i < res.data.values.length; i++) {
      const row = res.data.values[i];
      const msgSource = row[2] || ''; let msgTableTrans = row[4] || ''; const outAttach = row[6] || '';       
      const statusIn = row[7] || ''; const statusOut = row[8] || ''; const rowNumber = i + 1;

      if (statusIn !== 'Обработано' && statusOut !== 'Отправлено WA' && (msgSource.trim() !== '' || outAttach.trim() !== '')) {
        if (msgSource.trim() !== '' && msgTableTrans.trim() === '') {
          const formula = `=IF(LEFT($E$1; 1)="1"; INDIRECT("C" & ROW()); IF(LEFT($E$1; 1)="2"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "tr"); IF(LEFT($E$1; 1)="3"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "ru"); IF(LEFT($E$1; 1)="4"; GOOGLETRANSLATE(INDIRECT("C" & ROW()); "auto"; "en"); INDIRECT("C" & ROW())))))`;
          await sheets.spreadsheets.values.update({
             spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!E${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[formula]] }
          });
          await new Promise(r => setTimeout(r, 3000));
          const refetch = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!E${rowNumber}` });
          if (refetch.data.values && refetch.data.values.length > 0) msgTableTrans = refetch.data.values[0][0];
        }

        const textToSend = (msgTableTrans && msgTableTrans.trim() !== '') ? msgTableTrans : msgSource;
        const targetId = globalLid !== 'N/A' ? globalLid : globalCUs;
        let messageSent = false;

        try {
          let mediaObj = null;
          if (outAttach && outAttach.trim().startsWith('http')) {
            try {
              let directUrl = outAttach.trim(); let filename = `Attachment_${Date.now()}`;
              const driveMatch = directUrl.match(/\/d\/([a-zA-Z0-9_-]+)/) || directUrl.match(/id=([a-zA-Z0-9_-]+)/);
              if (driveMatch && driveMatch[1]) {
                directUrl = `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`; filename = `GDrive_File_${Date.now()}`;
              }
              const fetch = (await import('node-fetch')).default || global.fetch; 
              const response = await fetch(directUrl);
              if (!response.ok) throw new Error(`HTTP Error`);
              let mimeType = response.headers.get('content-type') || 'application/octet-stream';
              if (!mimeType.includes('text/html')) {
                const arrayBuffer = await response.arrayBuffer();
                mediaObj = new MessageMedia(mimeType, Buffer.from(arrayBuffer).toString('base64'), filename);
              }
            } catch (mediaErr) {}
          }

          if (mediaObj) {
            try { await client.sendMessage(targetId, mediaObj, { caption: textToSend }); messageSent = true; } catch (waErr) {}
          } 
          if (!messageSent) {
            const fallbackText = outAttach.trim() ? (textToSend ? `${textToSend}\n\n📎 Ссылка на файл: ${outAttach.trim()}` : `📎 Ссылка на файл: ${outAttach.trim()}`) : textToSend;
            if (fallbackText.trim() !== '') await client.sendMessage(targetId, fallbackText);
          }

          const timestamp = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Istanbul' });
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!A${rowNumber}:B${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [[timestamp, 'Алексей Знаменский (Таблица)']] } });
          await sheets.spreadsheets.values.update({ spreadsheetId: SPREADSHEET_ID, range: `'${globalSheetName}'!I${rowNumber}`, valueInputOption: 'USER_ENTERED', requestBody: { values: [['Отправлено WA']] } });
        } catch (sendErr) {}
      }
    }
  } catch (err) {}
}

// 14. Конфигурация Puppeteer
let chromiumPath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
if (!fs.existsSync(chromiumPath)) {
  if (fs.existsSync('/usr/bin/chromium')) chromiumPath = '/usr/bin/chromium';
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' },
  puppeteer: { executablePath: chromiumPath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));

client.on('ready', async () => {
  console.log('✅ WhatsApp клиент подключен на GCE!');
  await verifyAndFormatGoogleInfrastructure();
  await restoreChatHistoryAndStartLive();
  
  setInterval(listenForRepliesFromSheet, 15000);
  
  setInterval(async () => {
      await processDriveImports();
  }, 30000);
});

client.on('authenticated', () => console.log('🔒 Сессия авторизована.'));

// 15. Обработчик входящих живых сообщений
client.on('message_create', async (msg) => {
  if (!isHistoryLoaded) return;
  try {
    if (msg.fromMe && msg.body && msg.body.includes('Алексей Знаменский (Таблица)')) return;
    const isTargetChat = targetIdsArray.some(id => msg.from.includes(id) || msg.to.includes(id));

    if (isTargetChat) {
      if (!historySynced) {
        console.log('⚡ Получено живое сообщение! Ретроактивный захват истории...');
        const liveChatObj = await msg.getChat().catch(() => null);
        await syncMergedChatHistory(liveChatObj); 
      }

      let dynamicSenderName = globalContactName;
      if (msg.fromMe) dynamicSenderName = 'Алексей Знаменский';
      else {
          const contact = await msg.getContact().catch(() => null);
          if (contact && (contact.name || contact.pushname)) { globalContactName = contact.name || contact.pushname; dynamicSenderName = globalContactName; }
      }

      const realChatId = msg.fromMe ? msg.to : msg.from;
      let fileUrl = ''; let originalFilename = '';

      if (msg.hasMedia) {
        console.log(`⏳ [Медиа] Новое живое сообщение. Ждем 4 секунды для кэширования ключей сервером Meta...`);
        await new Promise(r => setTimeout(r, 4000));
        
        const media = await robustDownloadMedia(msg);
        if (media && media.data) {
          const ext = media.mimetype ? media.mimetype.split(';')[0].split('/')[1] : 'bin';
          let nameWithoutExt = media.filename ? media.filename.substring(0, media.filename.lastIndexOf('.')) || media.filename : 'Media';
          originalFilename = `${nameWithoutExt}_${Date.now()}.${ext}`;
          fileUrl = await uploadMediaToDrive(originalFilename, media.mimetype, media.data);
        }
      }
      
      const existing = await getExistingRowSignatures();
      const sig = `${new Date(msg.timestamp * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Istanbul' })}_${dynamicSenderName}_${msg.body || ''}`;
      
      if (!existing.has(sig)) await appendMessageToGoogleSheet(msg.body, dynamicSenderName, fileUrl, originalFilename, null, realChatId);
    }
  } catch (err) {}
});

client.initialize();
