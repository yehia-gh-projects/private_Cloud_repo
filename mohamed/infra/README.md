# Deployment

Everything the service runs on is described here, in Terraform. The emulator is
floci; the same files work against real AWS once the endpoints block and the
dummy credentials are removed.

## What it creates

| File | Contents |
|---|---|
| `main.tf` | everything, in seven sections: what already exists, the network, the cluster, the secrets, IAM, the load balancer, the task |
| `versions.tf` | terraform and provider versions, the endpoint map |
| `variables.tf` | inputs |
| `outputs.tf` | what to read back after an apply |

Four files rather than ten: Terraform reads every `.tf` file in the directory as
one module, so the split is only about what is pleasant to read.

Two things are not created here:

- the **KMS key** and the **sealed signing key**, because `scripts/seal-key.mjs`
  makes them once and destroying either makes the other useless;
- the **database**, because it is Neon and it exists before the service does.

## HTTPS, and why the certificate is self-signed

There is no HTTP listener. The load balancer serves HTTPS on 443 only, so nothing
reaches the application unencrypted.

The certificate has to be self-signed because there is no domain to validate one
for. `scripts/make-dev-cert.sh` generates it:

```bash
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout infra/tls/dev.key -out infra/tls/dev.crt \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```

`deploy/deploy.sh` runs that script when the files are missing, and `tls/` is
gitignored, so the private key never enters the repository. Terraform imports the
certificate into ACM and the listener references the ARN. On real AWS the same
resource becomes a normally validated certificate; nothing else changes.

Two expected consequences: the browser warns once because nobody signed the
certificate, and `curl` needs `-k`.

## Deploying

Terraform cannot build an image, so `deploy/deploy.sh` builds it and then calls
Terraform:

```bash
./deploy/deploy.sh                 # build, apply, verify
./deploy/deploy.sh --plan          # stop at the plan
./deploy/deploy.sh --no-build      # apply only
./deploy/deploy.sh --destroy       # remove the stack
```

The tag is the repository URL plus `:deploy`, the same string
`terraform output repository_url` prints. floci runs a locally tagged image by
that name instead of pulling from its ECR, so no `docker push` is needed here,
and the same tag would be pushed on real AWS.

## Run it by hand

```bash
export TF_VAR_image="000000000000.dkr.ecr.us-east-1.localhost:4566/class-tt/catalogue:deploy"
export TF_VAR_database_url="postgresql://user:password@host/db?sslmode=verify-full"

docker build -t "$TF_VAR_image" ..
cd mohamed/infra
terraform init
terraform apply -auto-approve
```

A second apply prints `No changes`, which is the expected result.

`image` and `database_url` are the two arguments you must supply, either as
environment variables as above or with `-var` on each command. `image` has no
default because Terraform cannot guess which build to run. `database_url` has no
default because a wrong one would deploy a task that cannot reach the database.

## Secret values and the state

Both secret versions are written with write-only arguments:

```hcl
resource "aws_secretsmanager_secret_version" "database" {
  secret_id                = aws_secretsmanager_secret.database.id
  secret_string_wo         = var.database_url
  secret_string_wo_version = 1
}
```

Terraform sends the value to Secrets Manager and never writes it back, so the
database URL and the Turnstile secret do not appear in `terraform.tfstate`:

```bash
grep -c "postgresql://" terraform.tfstate   # 0
```

The cost is that Terraform cannot compare the stored value with the variable, so
changing a secret needs the version number bumped as well:

1. set `secret_string_wo_version = 2` in the resource;
2. export the new `TF_VAR_database_url` (or `TF_VAR_turnstile_secret`);
3. `terraform apply`.

Without the bump the apply changes nothing, because the value alone is invisible
to the plan.

The state file still needs protecting even with the secrets out of it: it holds
the resource ids, the KMS key ARN and the task definition. `terraform.tfstate` is
gitignored, and `terraform.tfstate.backup` is the previous copy, so the whole
`infra/` directory should stay out of anything shared.

If a secret value did end up somewhere it should not be, in an older copy of the
file for example, rotating it at the source is the fix. Editing the state does
not help: the old value is still valid until the provider issues a new one.

## What you should see

```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8443/            # 200
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8443/readyz      # 404
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:8443/api/courses # 401
curl -s  -o /dev/null -w "%{http_code}\n" http://localhost:8080/             # 000, no listener
```

The 404 on `/readyz` is the point: the probe exists for the load balancer, not
for the internet. The listener answers it before the request reaches the app, and
the app would answer the same thing if it did.

## Reading it back

```bash
aws ecs describe-services --cluster class-tt-catalogue --services catalogue
aws elbv2 describe-target-health --target-group-arn "$(aws elbv2 describe-target-groups --names class-tt-tg --query 'TargetGroups[0].TargetGroupArn' --output text)"
aws logs tail /class-tt/catalogue --follow
```

## Differences from real AWS

- **No image pull.** floci prefers a local image with the ECR-shaped tag;
  `docker push` is not implemented in a way Docker Desktop here can use.
- **The task has a public IP.** Real AWS would put it in a private subnet behind
  a NAT gateway, with interface endpoints for ECR, Secrets Manager, KMS,
  CloudWatch and SES.
- **No IAM evaluation.** floci stores policies and does not enforce them, so a
  wrong ARN would still work. The policies are written to be correct on real AWS.
- **One host name.** The listener forwards only `Host: localhost` because a
  browser cannot set a Host header and floci serves every load balancer on one
  socket.
