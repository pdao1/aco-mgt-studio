import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { runMigrations } from '../database/migrate.js';
import { Repository } from '../database/repository.js';
import { SoloRepository } from './repository.js';
import { z } from 'zod';

// Local service-owner command. Never exposed as an anonymous signup/payment endpoint.
const {values}=parseArgs({options:{handle:{type:'string'},name:{type:'string'},'discord-id':{type:'string'},days:{type:'string',default:'30'},'mailbox-limit':{type:'string',default:'5'},rotate:{type:'boolean',default:false},renew:{type:'boolean',default:false}}});
if (values.rotate && values.renew) throw new Error('Choose either --rotate or --renew.');
const handle=z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/).parse(values.handle);
const days=z.coerce.number().int().min(1).max(3650).parse(values.days);
const config=loadConfig();
await runMigrations(config.databaseUrl,config.nodeEnv==='production');
const repository=new Repository(config.databaseUrl,config.nodeEnv==='production');
try {
  const accounts=new SoloRepository(repository);
  if(values.renew) {
    const expiry=await accounts.renewAccess(handle,days);
    console.info(`Solo Buyer access extended through ${expiry}. The existing serial is unchanged.`);
  } else if(values.rotate) {
    const serial=await accounts.rotateSerial(handle);
    console.info(`New Solo Buyer serial (shown once): ${serial}\nPrevious serial and sessions are invalid.`);
  } else {
    const result=await accounts.provision({handle,displayName:z.string().trim().min(1).max(120).parse(values.name??handle),
      discordId:values['discord-id'] ? z.string().regex(/^\d{17,20}$/).parse(values['discord-id']) : null,
      days,mailboxLimit:z.coerce.number().int().min(1).max(100).parse(values['mailbox-limit'])});
    console.info(`Solo Buyer account created: ${config.appOrigin}${result.path}\nProduct serial (shown once): ${result.serial}\nKeep the serial private. It is a login credential.`);
  }
} finally {await repository.close();}
