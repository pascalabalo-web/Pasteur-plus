import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv(file){
  try{
    if(!fs.existsSync(file)) return;
    for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
      const trimmed=line.trim();
      if(!trimmed || trimmed.startsWith('#')) continue;
      const i=trimmed.indexOf('='); if(i<0) continue;
      const key=trimmed.slice(0,i).trim(); let value=trimmed.slice(i+1).trim();
      if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
      if(key && process.env[key]===undefined) process.env[key]=value;
    }
  }catch(e){ console.warn('Impossible de charger .env :',e.message); }
}
loadDotEnv(path.join(__dirname,'.env'));

const PORT=Number(process.env.PORT||3000);
const API_KEY=process.env.OPENAI_API_KEY;
const MODEL=process.env.OPENAI_MODEL||'gpt-5.6-luna';
const SESSION_DAYS=Number(process.env.SESSION_DAYS||30);
const isProduction=process.env.NODE_ENV==='production';
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='false'?false:{rejectUnauthorized:false}});

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
function send(res,status,body,type='application/json',extra={}){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store',...extra});res.end(typeof body==='string'?body:JSON.stringify(body));}
function readBody(req){return new Promise((resolve,reject)=>{let b='';req.on('data',c=>{b+=c;if(b.length>50000)reject(new Error('Requête trop volumineuse.'));});req.on('end',()=>{try{resolve(JSON.parse(b||'{}'));}catch{reject(new Error('JSON invalide.'));}});});}
function safePath(urlPath){const decoded=decodeURIComponent(urlPath.split('?')[0]);const rel=decoded==='/'?'/index.html':decoded;const full=path.resolve(__dirname,'.'+rel);return full.startsWith(path.resolve(__dirname))?full:null;}
function parseCookies(req){const out={};for(const part of (req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1));}return out;}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex');}
function newToken(){return crypto.randomBytes(32).toString('hex');}
function passwordHash(password){const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(password,salt,64).toString('hex');return `${salt}:${hash}`;}
function passwordVerify(password,stored){const [salt,hex]=String(stored).split(':');if(!salt||!hex)return false;const a=Buffer.from(hex,'hex');const b=crypto.scryptSync(password,salt,64);return a.length===b.length&&crypto.timingSafeEqual(a,b);}
function setSessionCookie(res,token,req){const secure=(isProduction && req.headers['x-forwarded-proto']==='https')?' Secure;':'';res.setHeader('Set-Cookie',`ps_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS*86400}; SameSite=Lax;${secure}`);}
function clearSessionCookie(res){res.setHeader('Set-Cookie','ps_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax;');}
async function requireUser(req,res){const token=parseCookies(req).ps_session;if(!token){send(res,401,{error:'Votre session a expiré. Veuillez vous reconnecter.'});return null;}const {rows}=await pool.query(`SELECT p.id,p.prenom,p.nom,p.localisation,p.telephone FROM sessions s JOIN pastors p ON p.id=s.pastor_id WHERE s.token_hash=$1 AND s.expires_at>NOW()`,[tokenHash(token)]);if(!rows[0]){clearSessionCookie(res);send(res,401,{error:'Votre session a expiré. Veuillez vous reconnecter.'});return null;}return rows[0];}

const themeSchema={type:'json_schema',name:'prophetic_step_theme',strict:true,schema:{type:'object',additionalProperties:false,properties:{title:{type:'string'},introduction:{type:'string'},sections:{type:'array',items:{type:'object',additionalProperties:false,properties:{title:{type:'string'},content:{type:'string'}},required:['title','content']}},verses:{type:'array',items:{type:'object',additionalProperties:false,properties:{reference:{type:'string'},text:{type:'string'}},required:['reference','text']}},examples:{type:'array',items:{type:'object',additionalProperties:false,properties:{title:{type:'string'},content:{type:'string'}},required:['title','content']}},prayer:{type:'string'}},required:['title','introduction','sections','verses','examples','prayer']}};

async function generate(theme){
  if(!API_KEY) throw new Error('OPENAI_API_KEY n’est pas configurée sur le serveur.');
  const instructions=`Tu es un assistant biblique pour Prophetic Step Ministry, destiné aux pasteurs francophones. Le thème fourni est seulement un sujet demandé par l'utilisateur : ne prétends jamais qu'il vient réellement de Dieu. Produis une étude biblique sérieuse, équilibrée, approfondie et directement exploitable pour une prédication. La Bible est la source principale. Donne des références bibliques précises et ne fabrique jamais une citation. Si tu n'es pas certain du mot-à-mot d'un verset, indique la référence et paraphrase clairement sans guillemets. Développe plusieurs axes, donne des exemples bibliques et des exemples de la vie quotidienne, puis une application et une prière. Réponds uniquement selon le schéma JSON demandé.`;
  const payload={model:MODEL,instructions,input:`Thème demandé par le pasteur : ${theme}`,text:{format:themeSchema},store:false};
  const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const j=await r.json();
  if(!r.ok) throw new Error(j?.error?.message||'Erreur de l’API IA.');
  const text=j.output_text||''; if(!text) throw new Error('La réponse de l’IA est vide.');
  try{return JSON.parse(text);}catch{throw new Error('La réponse de l’IA n’a pas le format attendu.');}
}

async function initDb(){
  if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL n’est pas configurée.');
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`CREATE TABLE IF NOT EXISTS pastors(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),prenom VARCHAR(80) NOT NULL,nom VARCHAR(80) NOT NULL,localisation VARCHAR(160) NOT NULL,telephone VARCHAR(40) UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),pastor_id UUID NOT NULL REFERENCES pastors(id) ON DELETE CASCADE,token_hash CHAR(64) UNIQUE NOT NULL,expires_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_themes(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),pastor_id UUID NOT NULL REFERENCES pastors(id) ON DELETE CASCADE,prompt TEXT NOT NULL,title TEXT NOT NULL,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ai_themes_pastor_idx ON ai_themes(pastor_id,created_at DESC);`);
  await pool.query(`DELETE FROM sessions WHERE expires_at<NOW()`);
}

const rate=new Map();
function rateLimit(req){const ip=(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim();const now=Date.now();const arr=(rate.get(ip)||[]).filter(t=>now-t<60000);if(arr.length>=30)return false;arr.push(now);rate.set(ip,arr);return true;}

async function handleApi(req,res){
  if(!rateLimit(req))return send(res,429,{error:'Trop de requêtes. Réessayez dans une minute.'});
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true,service:'prophetic-step'});
  if(req.method==='POST'&&url.pathname==='/api/auth/register'){
    const b=await readBody(req);const {prenom,nom,localisation,telephone,password}=b;
    if(!prenom||!nom||!localisation||!telephone||!password)return send(res,400,{error:'Veuillez remplir tous les champs.'});
    if(String(password).length<8)return send(res,400,{error:'Le mot de passe doit contenir au moins 8 caractères.'});
    const exists=await pool.query('SELECT id FROM pastors WHERE telephone=$1',[String(telephone).trim()]);if(exists.rowCount)return send(res,409,{error:'Ce numéro possède déjà un compte. Connectez-vous.'});
    const {rows}=await pool.query('INSERT INTO pastors(prenom,nom,localisation,telephone,password_hash) VALUES($1,$2,$3,$4,$5) RETURNING id,prenom,nom,localisation,telephone',[String(prenom).trim(),String(nom).trim(),String(localisation).trim(),String(telephone).trim(),passwordHash(String(password))]);
    const token=newToken();await pool.query('INSERT INTO sessions(pastor_id,token_hash,expires_at) VALUES($1,$2,NOW()+($3||\' days\')::interval)',[rows[0].id,token,SESSION_DAYS]);setSessionCookie(res,token,req);return send(res,201,{pastor:rows[0]});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/login'){
    const b=await readBody(req);const {telephone,password}=b;if(!telephone||!password)return send(res,400,{error:'Entrez votre numéro et votre mot de passe.'});
    const q=await pool.query('SELECT id,prenom,nom,localisation,telephone,password_hash FROM pastors WHERE telephone=$1',[String(telephone).trim()]);if(!q.rows[0]||!passwordVerify(String(password),q.rows[0].password_hash))return send(res,401,{error:'Numéro ou mot de passe incorrect.'});
    const token=newToken();await pool.query('INSERT INTO sessions(pastor_id,token_hash,expires_at) VALUES($1,$2,NOW()+($3||\' days\')::interval)',[q.rows[0].id,token,SESSION_DAYS]);setSessionCookie(res,token,req);const {password_hash,...pastor}=q.rows[0];return send(res,200,{pastor});
  }
  if(req.method==='POST'&&url.pathname==='/api/auth/logout'){
    const token=parseCookies(req).ps_session;if(token)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[tokenHash(token)]);clearSessionCookie(res);return send(res,200,{ok:true});
  }
  if(req.method==='GET'&&url.pathname==='/api/auth/me'){
    const user=await requireUser(req,res);if(!user)return;return send(res,200,{pastor:user});
  }
  if(req.method==='GET'&&url.pathname==='/api/themes'){
    const user=await requireUser(req,res);if(!user)return;const {rows}=await pool.query('SELECT id,prompt,title,data,created_at AS "savedAt" FROM ai_themes WHERE pastor_id=$1 ORDER BY created_at DESC LIMIT 100',[user.id]);return send(res,200,{themes:rows});
  }
  if(req.method==='DELETE'&&url.pathname.startsWith('/api/themes/')){
    const user=await requireUser(req,res);if(!user)return;const id=url.pathname.split('/').pop();await pool.query('DELETE FROM ai_themes WHERE id=$1 AND pastor_id=$2',[id,user.id]);return send(res,200,{ok:true});
  }
  if(req.method==='POST'&&url.pathname==='/api/theme-ai'){
    const user=await requireUser(req,res);if(!user)return;const b=await readBody(req);const theme=String(b.theme||'').trim();if(theme.length<3)return send(res,400,{error:'Veuillez saisir un thème suffisamment précis.'});if(theme.length>180)return send(res,400,{error:'Le thème est trop long.'});
    const data=await generate(theme);const saved=await pool.query('INSERT INTO ai_themes(pastor_id,prompt,title,data) VALUES($1,$2,$3,$4) RETURNING id,prompt,title,data,created_at AS "savedAt"',[user.id,theme,data.title||theme,data]);return send(res,200,saved.rows[0]);
  }
  return send(res,404,{error:'Route API introuvable.'});
}

const server=http.createServer(async(req,res)=>{try{if((req.url||'').startsWith('/api/'))return await handleApi(req,res);if(req.method!=='GET')return send(res,405,{error:'Méthode non autorisée.'});const file=safePath(req.url||'/');if(!file)return send(res,403,{error:'Accès refusé.'});if(!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,404,{error:'Fichier introuvable.'});const ext=path.extname(file).toLowerCase();res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream'});fs.createReadStream(file).pipe(res);}catch(e){console.error(e);send(res,500,{error:e.message||'Erreur serveur.'});}});

initDb().then(()=>server.listen(PORT,()=>console.log(`Prophetic Step: http://localhost:${PORT}`))).catch(e=>{console.error('Échec du démarrage :',e.message);process.exit(1);});
