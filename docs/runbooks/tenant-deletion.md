# Runbook: tenant deletion

For CCPA / GDPR / contract-termination deletion requests.

## Scope

Removes everything under `TENANT#<tenantId>` in the product's DynamoDB table and everything under `tenants/<tenantId>/` in the artifacts bucket. Stripe customer/subscription handling is separate.

## Prerequisites

- The tenant has cancelled their subscription in Stripe (or you are deleting on contract termination).
- You have the `tenantId`. Find it by email: `aws dynamodb query --table-name <app>-<env> --index-name <user-by-email-gsi> --key-condition-expression "email = :e" --expression-attribute-values '{":e":{"S":"<user@example.com>"}}'` (GSI is Phase 1 work; until then, look it up via Cognito user attributes).
- You have a maintenance window or have notified the tenant.

## Steps

1. **Cancel Stripe subscription**, if not already done.
   ```
   stripe subscriptions cancel <sub_id>
   ```

2. **Disable the Cognito user(s)** under this tenant. Prevents any new JWT issuance.
   ```
   aws cognito-idp admin-disable-user --user-pool-id <pool> --username <sub>
   ```

3. **Snapshot DynamoDB** (optional but recommended).
   ```
   aws dynamodb create-backup --table-name <app>-<env> --backup-name tenant-delete-<tenantId>-<date>
   ```

4. **List items under the tenant prefix**.
   ```
   aws dynamodb query --table-name <app>-<env> \
     --key-condition-expression "PK = :pk" \
     --expression-attribute-values '{":pk":{"S":"TENANT#<tenantId>"}}' \
     --projection-expression "PK,SK"
   ```

5. **Delete items** in batches of 25 via `batch-write-item`. There is no scripted helper yet; write one when this runbook is invoked for the second time.

6. **Delete S3 objects** under `tenants/<tenantId>/`.
   ```
   aws s3 rm s3://<bucket>/tenants/<tenantId>/ --recursive
   ```

7. **Delete Cognito user(s)**.
   ```
   aws cognito-idp admin-delete-user --user-pool-id <pool> --username <sub>
   ```

8. **Write an audit row** under a sentinel tenant ID (`TENANT#_deleted` / `AUDIT#<iso-ts>`) so the deletion itself is auditable. Include `tenantId`, requester, ticket reference, what was deleted.

9. **Confirm to the requester** in writing.

## What survives

- The Stripe customer record (kept for accounting). Delete from Stripe Dashboard separately if required.
- CloudWatch logs (auto-expire per retention policy; consider tightening to 7 days before deletion if logs contain PII).
- DLQ messages with this tenant's data (purge `<app>-<env>-stripe-dlq` if you confirm any belong to this tenant).
- Backups created in step 3 (delete after the dispute window passes).

## Notes

- The DynamoDB table has `RemovalPolicy.RETAIN`. **Never** `cdk destroy` to satisfy a deletion request — that kills the table for every tenant.
- If a deletion-request volume warrants it, automate steps 4–7 into a Lambda triggered by an admin API endpoint. Don't build that automation before the second manual request.
