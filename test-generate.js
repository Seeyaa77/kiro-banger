require('dotenv').config();
const settings = require('./utils/settings');
const MailstackClient = require('./services/MailstackClient');

async function testGenerate() {
  console.log('🧪 Testing fresh @xyntaur.com inbox generation...\n');

  process.env.MAILSTACK_API_KEY = process.env.MAILSTACK_API_KEY || 'dummy';
  const client = new MailstackClient(process.env.MAILSTACK_API_KEY);

  // Test 1: createInbox with xyntaur.com
  console.log('✨ Test 1: createInbox("xyntaur.com")');
  const inbox = await client.createInbox('xyntaur.com');
  console.log(`   → ${inbox.email}`);
  console.log(`   Domain check: ${inbox.email.endsWith('@xyntaur.com') ? '✅ PASS' : '❌ FAIL'}`);

  // Test 2: settings.selectCleanInbox generates fresh @xyntaur.com
  console.log('\n✨ Test 2: settings.selectCleanInbox()');
  const fresh = await settings.selectCleanInbox({});
  console.log(`   → ${fresh.email}`);
  console.log(`   Domain check: ${fresh.email.endsWith('@xyntaur.com') ? '✅ PASS' : '❌ FAIL'}`);

  // Test 3: generate 3 in a row - all must be unique @xyntaur.com
  console.log('\n✨ Test 3: generate 3 fresh inboxes (uniqueness)');
  const batch = [];
  for (let i = 0; i < 3; i++) {
    const ib = await client.createInbox('xyntaur.com');
    batch.push(ib.email);
  }
  batch.forEach((e, i) => console.log(`   ${i + 1}. ${e}`));
  const allXyntaur = batch.every(e => e.endsWith('@xyntaur.com'));
  const allUnique = new Set(batch).size === batch.length;
  console.log(`   All @xyntaur.com: ${allXyntaur ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`   All unique: ${allUnique ? '✅ PASS' : '❌ FAIL'}`);

  console.log('\n✅ Done!\n');
}

testGenerate().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
