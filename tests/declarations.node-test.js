import { readFile, readdir, stat } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../server/db/schema.js';
import { INDEXES } from '../server/db/indexes.js';
import { SAVEABLE } from '../public/api/settings/PUT.js';
import * as stripe from '../server/providers/stripe.js';

/*
  Static checks that what the code asks for is what the extension declares.

  A permission checked by a route but never declared does not error — it answers "no", forever, for
  everyone but administrators, which is exactly why it survives testing by an administrator. An index
  the schema declares but install.js forgets exists only on a developer's database. A setting written
  without its declared `secret` type is a webhook secret stored in plain text. Each has a check here.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(root, file), 'utf8');
const config = JSON.parse(await read('kempo-config.json'));
const pkg = JSON.parse(await read('package.json'));

const walk = async (dir, match) => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for(const entry of entries){
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()) files.push(...await walk(full, match));
    else if(match(entry.name)) files.push(full);
  }
  return files;
};

const sources = [
  ...await walk(path.join(root, 'public'), name => /\.(js|html)$/.test(name)),
  ...await walk(path.join(root, 'server'), name => name.endsWith('.js')),
  ...await walk(path.join(root, 'admin'), name => /\.(js|html)$/.test(name)),
  ...await walk(path.join(root, 'hooks'), name => name.endsWith('.js')),
];
const contents = new Map(await Promise.all(sources.map(async file => [file, await readFile(file, 'utf8')])));
const relative = file => path.relative(root, file).replaceAll('\\', '/');

export default {
  'every permission the code checks is declared, and every declared one is enforced by a route': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    const used = new Set();
    for(const [file, text] of contents){
      for(const match of text.matchAll(/['"`](payouts:[a-z:-]+)['"`]/g)){
        if(match[1].startsWith('payouts:account-') || match[1].startsWith('payouts:charge-')) continue;
        if(!declared.has(match[1])) return fail(`${relative(file)} uses "${match[1]}", which nothing declares`);
        if(relative(file).startsWith('public/api/')) used.add(match[1]);
      }
    }
    for(const name of declared){
      if(!used.has(name)) return fail(`"${name}" is declared but no route checks it — it grants nothing`);
    }
    pass(`${declared.size} permissions`);
  },

  'every group grants only declared permissions, and can open the admin': async ({ pass, fail }) => {
    const declared = new Set(config.permissions.map(permission => permission.name));
    for(const group of config.groups){
      if(!group.name.startsWith('kempo-payouts:')) return fail(`group ${group.name} is not prefixed with the package name`);
      if(!group.permissions.includes('system:admin:access')) return fail(`${group.name} cannot open the admin without system:admin:access`);
      for(const permission of group.permissions.filter(name => name !== 'system:admin:access')){
        if(!declared.has(permission)) return fail(`${group.name} grants "${permission}", which is not declared`);
      }
      if(group.permissions.includes('payouts:connect')) return fail(`${group.name} grants payouts:connect, which belongs to every user via install.js`);
    }
    pass('');
  },

  'install.js creates every index the schema declares, and no others': async ({ pass, fail }) => {
    const declared = new Map();
    for(const table of Object.values(schema)){
      if(!table?.[Symbol.for('drizzle:Name')]) continue;
      const { name, indexes } = getTableConfig(table);
      for(const index of indexes){
        declared.set(index.config.name, { table: name, unique: index.config.unique, columns: index.config.columns.map(column => column.name) });
      }
    }
    const created = new Map(INDEXES.map(index => [index.name, index]));
    for(const [name, index] of declared){
      const made = created.get(name);
      if(!made) return fail(`${name} is declared in the schema but install.js never creates it`);
      const text = made.sql.queryChunks.map(chunk => chunk.value?.join?.('') ?? '').join('');
      if(index.unique !== /UNIQUE/.test(text)) return fail(`${name} is ${index.unique ? '' : 'not '}unique in the schema, and the other way in install.js`);
      if(index.unique && !made.required) return fail(`${name} is unique but not required — a missing unique index must fail the install`);
      if(!text.includes(`ON "${index.table}" (${index.columns.map(column => `"${column}"`).join(', ')})`)) return fail(`${name} covers ${index.table}(${index.columns}) in the schema, but install.js says: ${text}`);
    }
    for(const name of created.keys()){
      if(!declared.has(name)) return fail(`install.js creates ${name}, which the schema does not declare`);
    }
    pass(`${declared.size} indexes`);
  },

  'the settings route writes only declared settings, and the webhook secret is a secret': async ({ pass, fail }) => {
    const declared = new Map(config.settings.map(setting => [setting.name, setting]));
    for(const name of SAVEABLE){
      if(!declared.has(name)) return fail(`the settings route writes "${name}", which is not declared`);
    }
    for(const name of declared.keys()){
      if(!SAVEABLE.includes(name)) return fail(`"${name}" is declared but its screen cannot change it`);
    }
    if(declared.get('connect_webhook_secret')?.type !== 'secret') return fail('the Connect webhook secret is not declared as a secret');
    if([...declared.keys()].some(name => /secret_key|api_key/.test(name))) return fail('a Stripe key is declared here; it is kempo-payments’ and must not be duplicated');
    pass('');
  },

  'every route module loads and exports a handler, and the webhook route is where the provider says': async ({ pass, fail }) => {
    const routes = await walk(path.join(root, 'public', 'api'), name => /^(GET|POST|PUT|DELETE|PATCH)\.js$/.test(name));
    for(const file of routes){
      try {
        const module = await import(pathToFileURL(file).href);
        if(typeof module.default !== 'function') return fail(`${relative(file)} does not export a handler`);
      } catch(error) {
        return fail(`${relative(file)} does not load: ${error.message}`);
      }
    }
    if(stripe.webhookPath !== `/${config['public-scope']}/api/webhooks/${stripe.name}`) return fail(`the provider advertises ${stripe.webhookPath}`);
    if(!routes.some(file => relative(file) === 'public/api/webhooks/[provider]/POST.js')) return fail('nothing answers the webhook');
    pass(`${routes.length} routes`);
  },

  'no route starts a payment to a user — only the SDK does': async ({ pass, fail }) => {
    for(const [file, text] of contents){
      if(relative(file).startsWith('public/api/') && /createConnectedPayment|createPayment\(/.test(text)) return fail(`${relative(file)} starts a payment from a request`);
    }
    pass('');
  },

  'every hook kempo-config.json registers exists, and every account setup is one Stripe allows': async ({ pass, fail }) => {
    for(const [event, callback] of Object.entries(config.hooks)){
      if(!event.startsWith('payment:')) return fail(`${event} is not one of kempo-payments' hooks`);
      try {
        const module = await import(pathToFileURL(path.join(root, callback)).href);
        if(typeof module.default !== 'function') return fail(`${callback} does not export a handler`);
      } catch(error) {
        return fail(`${callback} does not load: ${error.message}`);
      }
    }
    if(!stripe.ACCOUNT_SETUPS[stripe.ACCOUNT_SETUP]) return fail(`ACCOUNT_SETUP is "${stripe.ACCOUNT_SETUP}", which is not one of the setups`);
    for(const [name, setup] of Object.entries(stripe.ACCOUNT_SETUPS)){
      // What Stripe answered in test mode, 2026-10-15: the Express Dashboard only with the platform collecting fees and liable.
      if(setup.dashboard === 'express' && (setup.feesCollector !== 'application' || setup.lossesCollector !== 'application')) return fail(`${name}: Stripe refuses the Express Dashboard unless the platform collects fees and carries losses`);
      if(setup.lossesCollector === 'application' && setup.feesCollector !== 'application') return fail(`${name}: Stripe requires fees_collector application when losses_collector is application`);
    }
    pass('');
  },

  'pages, nav and components are where the config and each other expect them, and prefixed k-payouts-': async ({ pass, fail }) => {
    for(const file of ['admin/index.page.html', 'admin/account/index.page.html', 'admin/charge/index.page.html', 'admin/nav.global.html', 'public/index.page.html', 'public/sdk.js']){
      if(!await stat(path.join(root, file)).catch(() => null)) return fail(`${file} does not exist`);
    }
    for(const [file, text] of contents){
      for(const match of text.matchAll(/customElements\.define\(\s*['"]([^'"]+)['"]/g)){
        if(!match[1].startsWith('k-payouts-')) return fail(`${relative(file)} defines <${match[1]}>`);
      }
      for(const match of text.matchAll(/from '\/([a-z-]+)\/(?:sdk\.js|utils|components)/g)){
        if(!['payouts', 'payments', 'kempo-ui', 'kempo'].includes(match[1])) return fail(`${relative(file)} imports from /${match[1]}/`);
      }
      for(const match of text.matchAll(/src="\/admin\/extension\/([a-z-]+)\//g)){
        if(match[1] !== pkg.name) return fail(`${relative(file)} loads from /admin/extension/${match[1]}/`);
      }
    }
    const nav = await read('admin/nav.global.html');
    if(!/group="Commerce"/.test(nav)) return fail('the nav entry is not in the Commerce group');
    pass('');
  },

  'no HTTP-specific code in server/utils': async ({ pass, fail }) => {
    for(const [file, text] of contents){
      if(!relative(file).startsWith('server/utils/')) continue;
      if(/\b(request|response)\.(cookies|headers|body|query|params|status|json)\b/.test(text)) return fail(`${relative(file)} reads a request or writes a response`);
    }
    pass('');
  },

  'the package ships everything it needs, depends on kempo-payments, and declares no file: specifier': async ({ pass, fail }) => {
    for(const entry of ['admin', 'hooks', 'public', 'server', 'install.js', 'update.js', 'uninstall.js', 'sdk.js', 'kempo-config.json']){
      if(!pkg.files.includes(entry)) return fail(`package.json "files" leaves out ${entry}`);
    }
    for(const field of ['dependencies', 'devDependencies', 'peerDependencies']){
      for(const [name, range] of Object.entries(pkg[field] || {})){
        if(String(range).startsWith('file:')) return fail(`${field}.${name} is ${range}`);
      }
    }
    if(!/^>=0\.2\.\d+$/.test(pkg.peerDependencies['kempo-payments'] || '')) return fail('kempo-payments must be a peer at the minor that has connected-account support (>=0.2.0)');
    if(!config.dependencies.includes('kempo-payments')) return fail('kempo-config.json does not require kempo-payments');
    if('kempo' in pkg) return fail('package.json has a kempo field; it lives in kempo-config.json only');
    pass('');
  },

  /*
    Payment state is kempo-payments'. This extension reaches it only through kempo-payments/sdk and
    never writes its tables, so there is one record of every payment.
  */
  'payments are reached only through kempo-payments/sdk': async ({ pass, fail }) => {
    for(const [file, text] of contents){
      if(/\bkempoPayment(Refund|Event)?\b/.test(text)) return fail(`${relative(file)} names a kempo-payments table`);
      if(/from\s+['"]kempo-payments\/(?!sdk['"])/.test(text)) return fail(`${relative(file)} imports from inside kempo-payments`);
    }
    pass('');
  },
};
