// Creates the Compare & Share DynamoDB table on LOCAL Floci.
//
//   node scripts/create-floci-table.js        (from the mohab folder)
//
// The table matches what src/shareStore.js expects:
//   partition key  token (string)
//   GSI            ownerId-index on ownerId (string), all attributes projected
//   TTL            expiresAtEpoch (seconds), so expired links are cleaned up
//   billing        on demand (PAY_PER_REQUEST)
//
// Safety:
//   - only a loopback endpoint is accepted and Floci's dummy credentials are
//     always used, so this can never reach real AWS;
//   - if the table already exists it is left exactly as it is (no update, no
//     delete, no data touched) and the script only reports what it found.
//
// Optional settings: FLOCI_ENDPOINT (default http://127.0.0.1:4566),
// SHARE_TABLE_NAME (default share_links), AWS_REGION (default us-east-1).
'use strict';

const {
  DynamoDBClient,
  DescribeTableCommand,
  CreateTableCommand,
  UpdateTimeToLiveCommand,
  DescribeTimeToLiveCommand,
  waitUntilTableExists
} = require('@aws-sdk/client-dynamodb');
const { OWNER_INDEX_NAME } = require('../src/shareStore');

const endpoint = process.env.FLOCI_ENDPOINT || 'http://127.0.0.1:4566';
const tableName = process.env.SHARE_TABLE_NAME || 'share_links';
const region = process.env.AWS_REGION || 'us-east-1';

if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
  console.error(`Refusing: FLOCI_ENDPOINT must be a local address (http://127.0.0.1:<port>), got ${endpoint}`);
  process.exit(1);
}

const client = new DynamoDBClient({
  region,
  endpoint,
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  maxAttempts: 1
});

async function describe() {
  const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
  const ttl = await client
    .send(new DescribeTimeToLiveCommand({ TableName: tableName }))
    .then((r) => r.TimeToLiveDescription)
    .catch((err) => ({ error: err.name }));
  return {
    table: Table.TableName,
    status: Table.TableStatus,
    keys: Table.KeySchema,
    indexes: (Table.GlobalSecondaryIndexes || []).map((g) => g.IndexName),
    billing: Table.BillingModeSummary ? Table.BillingModeSummary.BillingMode : undefined,
    items: Table.ItemCount,
    ttl
  };
}

async function main() {
  try {
    const existing = await describe();
    console.log(`${tableName} already exists - left unchanged`);
    console.log(JSON.stringify(existing, null, 2));
    return;
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') throw err;
  }

  await client.send(new CreateTableCommand({
    TableName: tableName,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [
      { AttributeName: 'token', AttributeType: 'S' },
      { AttributeName: 'ownerId', AttributeType: 'S' }
    ],
    KeySchema: [{ AttributeName: 'token', KeyType: 'HASH' }],
    GlobalSecondaryIndexes: [{
      IndexName: OWNER_INDEX_NAME,
      KeySchema: [{ AttributeName: 'ownerId', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' }
    }]
  }));
  await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: tableName });
  await client.send(new UpdateTimeToLiveCommand({
    TableName: tableName,
    TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAtEpoch' }
  }));

  console.log(`created ${tableName}`);
  console.log(JSON.stringify(await describe(), null, 2));
}

main().catch((err) => {
  console.error('create-floci-table failed:', err.name, err.message);
  process.exit(1);
});
