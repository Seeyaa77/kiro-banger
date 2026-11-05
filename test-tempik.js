const MailstackClient = require('./services/MailstackClient');

async function testTempikAPI() {
  console.log('🧪 Testing Tempik API integration...\n');

  const client = new MailstackClient('dummy'); // No API key needed

  try {
    // Test 1: Get all inboxes
    console.log('📬 Test 1: Fetching inboxes...');
    const inboxes = await client.getInboxes();
    console.log(`✅ Found ${inboxes.length} inboxes`);
    
    if (inboxes.length > 0) {
      console.log('\nSample inbox:');
      console.log(`  - Email: ${inboxes[0].email}`);
      console.log(`  - Created: ${inboxes[0].created_at}`);
      console.log(`  - Messages: ${inboxes[0].message_count}`);
    }

    // Test 2: Get messages from first inbox with messages
    const inboxWithMessages = inboxes.find(i => i.message_count > 0);
    
    if (inboxWithMessages) {
      console.log(`\n📨 Test 2: Fetching messages from ${inboxWithMessages.email}...`);
      const messages = await client.getMessages(inboxWithMessages.email, 5);
      console.log(`✅ Found ${messages.length} messages`);
      
      if (messages.length > 0) {
        console.log('\nSample message:');
        console.log(`  - ID: ${messages[0].id}`);
        console.log(`  - From: ${messages[0].from}`);
        console.log(`  - Subject: ${messages[0].subject}`);
        console.log(`  - Date: ${messages[0].date}`);
        
        // Test 3: Get full message
        console.log(`\n📧 Test 3: Fetching full message...`);
        const fullMsg = await client.getMessage(inboxWithMessages.email, messages[0].id);
        console.log(`✅ Retrieved message with body length: ${fullMsg.body?.length || 0} chars`);
        
        // Test 4: Extract verification code
        console.log(`\n🔢 Test 4: Testing code extraction...`);
        const code = client.extractCode(fullMsg);
        if (code) {
          console.log(`✅ Extracted code: ${code}`);
        } else {
          console.log(`⚠️  No code found (might not be a verification email)`);
        }
      }
    } else {
      console.log('\n⚠️  No inboxes with messages found. Skipping message tests.');
    }

    // Test 5: Clean inbox selection
    console.log(`\n🧹 Test 5: Testing clean inbox selection...`);
    try {
      const cleanInbox = await client.selectCleanInbox();
      console.log(`✅ Selected clean inbox: ${cleanInbox.email}`);
    } catch (error) {
      console.log(`⚠️  ${error.message}`);
    }

    console.log('\n✅ All tests completed successfully!\n');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Status:', error.response.status);
      console.error('   Data:', error.response.data);
    }
    process.exit(1);
  }
}

testTempikAPI();
