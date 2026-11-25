variable "region" {
  type    = string
  default = "us-east-1"
}

# floci's address. Point this at AWS by deleting the endpoints block in
# versions.tf and the three skip_* flags; keep everything else.
variable "endpoint" {
  type    = string
  default = "http://127.0.0.1:4566"
}

# What the *container* should call. Terraform runs on the host and reaches floci
# at 127.0.0.1, but the task is a container on the compose network and reaches it
# by service name - the same string the bash version used.
variable "container_endpoint" {
  type    = string
  default = "http://floci:4566"
}

variable "access_key" {
  type      = string
  default   = "test"
  sensitive = true
}

variable "secret_key" {
  type      = string
  default   = "test"
  sensitive = true
}

variable "name" {
  type        = string
  default     = "class-tt"
  description = "Prefix for every resource name."
}

variable "image" {
  type        = string
  description = "Image the task runs. Use the ECR repository URL plus a tag."
}

variable "database_url" {
  type        = string
  sensitive   = true
  description = "Postgres connection string. Stored in Secrets Manager, injected as DATABASE_URL."
}

variable "turnstile_secret" {
  type        = string
  sensitive   = true
  default     = "1x0000000000000000000000000000000AA"
  description = "Cloudflare Turnstile secret. The default is Cloudflare's always-pass test key."
}

variable "public_base_url" {
  type        = string
  default     = "https://localhost:8443"
  description = "What the service puts in email links. Must be the URL a user can open."
}

variable "mail_from" {
  type    = string
  default = "noreply@class-tt.local"
}

# A listener rule forwards only requests whose Host header is one of these, and
# a browser cannot set a Host header - so on the emulator the address you type
# is the host that must appear here.
variable "public_hosts" {
  type    = list(string)
  default = ["localhost"]
}

variable "app_port" {
  type    = number
  default = 3000
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "max_count" {
  type    = number
  default = 4
}

# Target tracking on requests per target: the service waits on the database, so
# CPU stays flat while requests queue.
variable "target_requests_per_task" {
  type    = number
  default = 100
}

# Neon suspends idle compute; the first connection after a pause is slow.
variable "ready_timeout_ms" {
  type    = number
  default = 3000
}

# A self-signed certificate for the demo. scripts/make-dev-cert.sh writes these
# two files; they are gitignored because a private key does not belong in a repo,
# even a throwaway one.
variable "tls_certificate_path" {
  type    = string
  default = "tls/dev.crt"
}

variable "tls_private_key_path" {
  type    = string
  default = "tls/dev.key"
}

variable "rate_limit_max" {
  type        = number
  default     = 60
  description = "Requests per window, per task. The shipped value is 60 per minute; a load test raises it to measure the service behind the limiter."
}
