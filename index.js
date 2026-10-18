import { sendGeneric } from '../generic.js';
const t = (s) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 120);
const hostOk = (h, re) => { h = String(h || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''); if (!re.test(h)) throw Object.assign(new Error('হোস্ট গ্রহণযোগ্য নয়'), { validation: true }); return h; };

/** Each preset: {label, region, verified, note, fields:[{name,label,secret,required}], send({to,text,v,http,unicode})}.
 *  `to` is digits with country code (8801XXXXXXXXX). v = plain fields + decrypted secrets. Never put credentials in error strings. */
export const PRESETS = {
  bulksmsbd: {
    label: 'BulkSMSBD', region: 'bd', verified: 'partial',
    note: 'বেস URL ও সফল কোড (202) তৃতীয়-পক্ষ ডকুমেন্টেশন থেকে মিলেছে; এন্ডপয়েন্ট পাথ স্মৃতি থেকে। অ্যাকাউন্টে IP whitelist বন্ধ রাখতে হবে।',
    fields: [{ name: 'api_key', label: 'API Key', secret: true, required: true }, { name: 'senderid', label: 'Sender ID', required: true }],
    async send({ to, text, v, http }) {
      const r = await http('https://bulksmsbd.net/api/smsapi', { form: { api_key: v.api_key, senderid: v.senderid, type: 'text', number: to, message: text } });
      const c = String(r.json?.response_code ?? '');
      return c === '202' ? { ok: true } : { ok: false, error: `bulksmsbd:${r.status}:${c || t(r.text)}` };
    },
  },
  greenweb: {
    label: 'Greenweb SMS', region: 'bd', verified: 'partial',
    note: 'এন্ডপয়েন্ট ও প্যারামিটার (token, to, message) প্রোভাইডারের ডকুমেন্টেশনে মিলেছে; সফলতার শনাক্তকরণ রেসপন্সে "SENT"/"Ok" খুঁজে।',
    fields: [{ name: 'token', label: 'Token', secret: true, required: true }],
    async send({ to, text, v, http }) {
      const r = await http('https://api.bdbulksms.net/api.php?json', { form: { token: v.token, to, message: text } });
      const ok = r.status < 400 && (/"status"\s*:\s*"SENT"/i.test(r.text) || /^\s*Ok:/i.test(r.text));
      return ok ? { ok: true } : { ok: false, error: `greenweb:${r.status}:${t(r.text)}` };
    },
  },
  alphasms: {
    label: 'Alpha SMS (sms.net.bd)', region: 'bd', verified: 'verified',
    note: 'অফিসিয়াল ডকুমেন্টেশনের সাথে মিলেছে (POST https://api.sms.net.bd/sendsms, সফল হলে error=0)।',
    fields: [{ name: 'api_key', label: 'API Key', secret: true, required: true }, { name: 'sender_id', label: 'Sender ID (ঐচ্ছিক)' }],
    async send({ to, text, v, http }) {
      const form = { api_key: v.api_key, msg: text, to }; if (v.sender_id) form.sender_id = v.sender_id;
      const r = await http('https://api.sms.net.bd/sendsms', { form });
      return r.json && Number(r.json.error) === 0 ? { ok: true } : { ok: false, error: `alphasms:${r.status}:${r.json?.error ?? ''} ${t(r.json?.msg ?? r.text)}` };
    },
  },
  mimsms: {
    label: 'MiMSMS', region: 'bd', verified: 'partial',
    note: 'পাথ (POST /api/SmsSending/SMS), JSON ফিল্ড ও সফল statusCode "200" অফিসিয়াল ডকে মিলেছে; হোস্ট নিশ্চিত নয়, তাই আপনার প্যানেলের ডকুমেন্টেশন অনুযায়ী "হোস্ট" ফিল্ড দিন (*.mimsms.com)।',
    fields: [{ name: 'host', label: 'API হোস্ট (যেমন api.mimsms.com)', required: true }, { name: 'UserName', label: 'UserName', required: true }, { name: 'Apikey', label: 'API Key', secret: true, required: true }, { name: 'SenderName', label: 'Sender Name', required: true }],
    async send({ to, text, v, http }) {
      const host = hostOk(v.host, /^[a-z0-9.-]+\.mimsms\.com$/i);
      const r = await http(`https://${host}/api/SmsSending/SMS`, { json: { UserName: v.UserName, Apikey: v.Apikey, MobileNumber: to, SenderName: v.SenderName, TransactionType: 'T', Message: text } });
      return r.json && String(r.json.statusCode) === '200' ? { ok: true } : { ok: false, error: `mimsms:${r.status}:${r.json?.statusCode ?? ''} ${t(r.json?.responseResult ?? r.text)}` };
    },
  },
  sslwireless: {
    label: 'SSL Wireless (SMS Plus)', region: 'bd', verified: 'unverified',
    note: 'অযাচাইকৃত: এই সেশনে ডকুমেন্টেশন পাওয়া যায়নি; এন্ডপয়েন্ট ও ফিল্ড স্মৃতি থেকে। প্যানেলের ডক মিলিয়ে নিন, নইলে Generic HTTP ব্যবহার করুন।',
    fields: [{ name: 'api_token', label: 'API Token', secret: true, required: true }, { name: 'sid', label: 'SID (Sender)', required: true }],
    async send({ to, text, v, http }) {
      const r = await http('https://smsplus.sslwireless.com/api/v3/send-sms', { json: { api_token: v.api_token, sid: v.sid, msisdn: to, sms: text, csms_id: 'dd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) } });
      return r.json && String(r.json.status).toUpperCase() === 'SUCCESS' ? { ok: true } : { ok: false, error: `ssl:${r.status}:${t(r.json?.error_message ?? r.text)}` };
    },
  },
  twilio: {
    label: 'Twilio', region: 'intl', verified: 'unverified',
    note: 'অযাচাইকৃত: এই সেশনে ডকুমেন্টেশন মেলানো হয়নি (Messages API, Basic Auth)। From অথবা Messaging Service SID একটা দিন।',
    fields: [{ name: 'account_sid', label: 'Account SID', required: true }, { name: 'auth_token', label: 'Auth Token', secret: true, required: true }, { name: 'from', label: 'From (+নম্বর)' }, { name: 'messaging_service_sid', label: 'Messaging Service SID' }],
    async send({ to, text, v, http }) {
      if (!/^AC[0-9a-f]{32}$/i.test(v.account_sid || '')) return { ok: false, error: 'twilio:account_sid ভুল' };
      const form = { To: '+' + to, Body: text }; if (v.messaging_service_sid) form.MessagingServiceSid = v.messaging_service_sid; else form.From = v.from;
      const r = await http(`https://api.twilio.com/2010-04-01/Accounts/${v.account_sid}/Messages.json`, { form, basic: [v.account_sid, v.auth_token] });
      return r.status === 201 && r.json?.sid ? { ok: true } : { ok: false, error: `twilio:${r.status}:${r.json?.code ?? ''} ${t(r.json?.message ?? r.text)}` };
    },
  },
  vonage: {
    label: 'Vonage (Nexmo)', region: 'intl', verified: 'unverified',
    note: 'অযাচাইকৃত: এই সেশনে ডকুমেন্টেশন মেলানো হয়নি (SMS API /sms/json)।',
    fields: [{ name: 'api_key', label: 'API Key', required: true }, { name: 'api_secret', label: 'API Secret', secret: true, required: true }, { name: 'from', label: 'From', required: true }],
    async send({ to, text, v, http, unicode }) {
      const form = { api_key: v.api_key, api_secret: v.api_secret, to, from: v.from, text }; if (unicode) form.type = 'unicode';
      const r = await http('https://rest.nexmo.com/sms/json', { form });
      const m = r.json?.messages?.[0];
      return m && String(m.status) === '0' ? { ok: true } : { ok: false, error: `vonage:${r.status}:${m?.status ?? ''} ${t(m?.['error-text'] ?? r.text)}` };
    },
  },
  infobip: {
    label: 'Infobip', region: 'intl', verified: 'unverified',
    note: 'অযাচাইকৃত: এই সেশনে ডকুমেন্টেশন মেলানো হয়নি (/sms/2/text/advanced)। Base URL হলো আপনার অ্যাকাউন্টের হোস্ট (xxxx.api.infobip.com)।',
    fields: [{ name: 'host', label: 'Base URL/হোস্ট', required: true }, { name: 'api_key', label: 'API Key', secret: true, required: true }, { name: 'sender', label: 'Sender', required: true }],
    async send({ to, text, v, http }) {
      const host = hostOk(v.host, /^[a-z0-9.-]+\.infobip\.com$/i);
      const r = await http(`https://${host}/sms/2/text/advanced`, { headers: { authorization: 'App ' + v.api_key }, json: { messages: [{ destinations: [{ to }], from: v.sender, text }] } });
      const g = r.json?.messages?.[0]?.status?.groupId;
      return r.status === 200 && [1, 3].includes(Number(g)) ? { ok: true } : { ok: false, error: `infobip:${r.status}:${g ?? ''} ${t(r.json?.messages?.[0]?.status?.description ?? r.json?.requestError?.serviceException?.text ?? r.text)}` };
    },
  },
  plivo: {
    label: 'Plivo', region: 'intl', verified: 'unverified',
    note: 'অযাচাইকৃত: এই সেশনে ডকুমেন্টেশন মেলানো হয়নি (Message API, Basic Auth)।',
    fields: [{ name: 'auth_id', label: 'Auth ID', required: true }, { name: 'auth_token', label: 'Auth Token', secret: true, required: true }, { name: 'src', label: 'Source (নম্বর/Sender ID)', required: true }],
    async send({ to, text, v, http }) {
      if (!/^[A-Za-z0-9]{10,40}$/.test(v.auth_id || '')) return { ok: false, error: 'plivo:auth_id ভুল' };
      const r = await http(`https://api.plivo.com/v1/Account/${v.auth_id}/Message/`, { json: { src: v.src, dst: to, text }, basic: [v.auth_id, v.auth_token] });
      return r.status === 202 ? { ok: true } : { ok: false, error: `plivo:${r.status}:${t(r.json?.error ?? r.text)}` };
    },
  },
  bird: {
    label: 'MessageBird / Bird', region: 'intl', verified: 'unverified',
    note: 'অযাচাইকৃত: এই সেশনে ডকুমেন্টেশন মেলানো হয়নি (rest.messagebird.com/messages, AccessKey)। নতুন Bird প্ল্যাটফর্মে API আলাদা হতে পারে; তখন Generic HTTP ব্যবহার করুন।',
    fields: [{ name: 'access_key', label: 'Access Key', secret: true, required: true }, { name: 'originator', label: 'Originator', required: true }],
    async send({ to, text, v, http }) {
      const r = await http('https://rest.messagebird.com/messages', { headers: { authorization: 'AccessKey ' + v.access_key }, json: { originator: v.originator, recipients: [to], body: text } });
      return r.status === 201 ? { ok: true } : { ok: false, error: `bird:${r.status}:${t(r.json?.errors?.[0]?.description ?? r.text)}` };
    },
  },
  generic: {
    label: 'Generic HTTP', region: 'any', verified: 'custom',
    note: 'যেকোনো প্রোভাইডার: URL/হেডার/বডি টেমপ্লেটে {{to}}, {{text}}, {{sender}}, {{secret.NAME}} ব্যবহার করুন। শুধু https (http-এ স্পষ্ট সম্মতি), প্রাইভেট IP ব্লকড।',
    fields: [{ name: 'sender', label: 'Sender (ঐচ্ছিক, {{sender}})' }],
    async send({ to, text, v, http, generic, secrets }) { return sendGeneric({ to, text, sender: v.sender, secrets, http, generic }); },
  },
};
export const presetList = () => Object.entries(PRESETS).map(([type, p]) => ({ type, label: p.label, region: p.region, verified: p.verified, note: p.note, fields: p.fields }));
