import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import path from 'path';

/*
  Puts the sibling checkouts this package works with into node_modules as *copies*, not links.

  `npm install ../kempo-payments` makes a symlink, and a symlinked package resolves `kempo` and
  `drizzle-orm` from its own node_modules — a second copy of each, and with it a second database.
  What a release would have put there is the files its package.json lists under `files`, plus
  package.json itself and the README, so that is exactly what is copied.

  Copied by hand rather than `npm install`ed: npm treats a package whose version matches what is
  already there as up to date and leaves the old files in place, which for a sibling that is
  mid-development and has not been given a new version is always.

  This is how the unreleased kempo-payments with connected-account support is used while it is
  unreleased. Never commit a `file:` specifier instead.

  Usage: npm run link:local
*/

const root = path.resolve(import.meta.dirname, '..');
const siblings = ['kempo-payments'];

for(const name of siblings){
  const source = path.resolve(root, '..', name);
  const target = path.join(root, 'node_modules', name);
  const { files = [] } = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });

  for(const entry of [...files, 'package.json', 'README.md', 'CHANGELOG.md']){
    if(existsSync(path.join(source, entry))) cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
  }
  console.log(`${name}: copied from ${source}`);
}
