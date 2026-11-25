# The deployment, in build order: what already exists, network, cluster,
# secrets, IAM, load balancer, task.

# -----------------------------------------------------------------------------
# What already exists
# -----------------------------------------------------------------------------

# The KMS key and the sealed signing key are created once by scripts/seal-key.mjs.
# Terraform reads them so it can grant access; it never owns their lifecycle,
# because destroying either makes the other useless.
data "aws_kms_alias" "keystore" {
  name = "alias/class-tt-keystore"
}

data "aws_secretsmanager_secret" "jwt_signing_key" {
  name = "class-tt/jwt-signing-key"
}

data "aws_caller_identity" "current" {}

# -----------------------------------------------------------------------------
# Network
# -----------------------------------------------------------------------------

resource "aws_vpc" "main" {
  cidr_block = "10.20.0.0/16"

  tags = {
    Name = "${var.name}-vpc"
  }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = "${var.region}a"

  tags = {
    Name = "${var.name}-public-a"
  }
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.2.0/24"
  availability_zone = "${var.region}b"

  tags = {
    Name = "${var.name}-public-b"
  }
}

# Two groups so each side can name the other. With one shared group, "only the
# load balancer may reach 3000" cannot be expressed: a rule referencing the
# group would let the group reach itself.
resource "aws_security_group" "alb" {
  name        = "${var.name}-alb-sg"
  description = "Public entry point: 80 from the internet, egress only to the tasks."
  vpc_id      = aws_vpc.main.id
}

resource "aws_security_group" "app" {
  name        = "${var.name}-app-sg"
  description = "The task: 3000 from the load balancer only, egress to the database and AWS."
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_app" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Forward to the task port only"
  referenced_security_group_id = aws_security_group.app.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"

  # floci echoes the reference as "<account>/sg-â€¦"; the rule is still created
  # from the attribute above, only that spelling is ignored.
  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

resource "aws_vpc_security_group_ingress_rule" "app_from_alb" {
  security_group_id            = aws_security_group.app.id
  description                  = "Application port from the load balancer only"
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"

  lifecycle {
    ignore_changes = [referenced_security_group_id]
  }
}

# Egress is open because the task reaches Neon, floci and the AWS APIs by name.
# Narrowing it needs those addresses as inputs.
resource "aws_vpc_security_group_egress_rule" "app_all" {
  security_group_id = aws_security_group.app.id
  description       = "Outbound to the database, floci and AWS APIs"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

# -----------------------------------------------------------------------------
# Cluster
# -----------------------------------------------------------------------------

resource "aws_ecs_cluster" "main" {
  name = "${var.name}-catalogue"

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# -----------------------------------------------------------------------------
# Secrets, logs, images
# -----------------------------------------------------------------------------

# A secret is an identity (policies name it) and a version is a value (it
# rotates), so they are two resources.
resource "aws_secretsmanager_secret" "database" {
  name = "${var.name}/database"
}

resource "aws_secretsmanager_secret_version" "database" {
  secret_id                = aws_secretsmanager_secret.database.id
  secret_string_wo         = var.database_url
  secret_string_wo_version = 1
}

resource "aws_secretsmanager_secret" "turnstile" {
  name = "${var.name}/turnstile"
}

resource "aws_secretsmanager_secret_version" "turnstile" {
  secret_id                = aws_secretsmanager_secret.turnstile.id
  secret_string_wo         = var.turnstile_secret
  secret_string_wo_version = 1
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/${var.name}/catalogue"
  retention_in_days = 30
}

# -----------------------------------------------------------------------------
# Monitoring: metrics made from the log lines, alarms on those metrics,
# one dashboard. No agent is involved, and no platform metric is required,
# which matters because floci publishes none.
# -----------------------------------------------------------------------------

locals {
  metric_namespace = "ClassTT/Catalogue"

  # The service writes one JSON object per line, so a pattern over a field is
  # all a metric needs. The request line carries status and ms; error lines
  # carry a stable msg and an error code.
  metric_filters = {
    Requests     = { pattern = "{ $.msg = \"request\" }", value = "1" }
    ServerErrors = { pattern = "{ $.msg = \"request\" && $.status >= 500 }", value = "1" }
    AuthFailures = { pattern = "{ $.msg = \"request\" && $.status = 401 }", value = "1" }
    Forbidden    = { pattern = "{ $.msg = \"request\" && $.status = 403 }", value = "1" }
    RateLimited  = { pattern = "{ $.msg = \"request\" && $.status = 429 }", value = "1" }
    Unhandled    = { pattern = "{ $.msg = \"unhandled error\" }", value = "1" }
    OutboxFailed = { pattern = "{ $.msg = \"mail.failed\" }", value = "1" }
    LatencyMs    = { pattern = "{ $.msg = \"request\" }", value = "$.ms" }

    Logins               = { pattern = "{ $.msg = \"auth.login\" }", value = "1" }
    Lockouts             = { pattern = "{ $.msg = \"auth.login.locked\" }", value = "1" }
    RegisterDuplicate    = { pattern = "{ $.msg = \"auth.register.duplicate\" }", value = "1" }
    ResetUnknownAddress  = { pattern = "{ $.msg = \"auth.reset.unknown_address\" }", value = "1" }
    TurnstileUnavailable = { pattern = "{ $.msg = \"turnstile.unavailable\" }", value = "1" }
    TurnstileError       = { pattern = "{ $.msg = \"turnstile.error\" }", value = "1" }
    DatabasePoolErrors   = { pattern = "{ $.msg = \"database pool error\" }", value = "1" }
    DatabaseUnreachable  = { pattern = "{ $.msg = \"database not reachable at boot\" }", value = "1" }
    ImportsCommitted     = { pattern = "{ $.msg = \"import.committed\" }", value = "1" }
    ImportsRejected      = { pattern = "{ $.msg = \"import.rejected\" }", value = "1" }
  }
}

resource "aws_cloudwatch_log_metric_filter" "this" {
  for_each = local.metric_filters

  name           = "${var.name}-catalogue-${lower(each.key)}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.key
    namespace = local.metric_namespace
    value     = each.value.value
  }
}

resource "aws_cloudwatch_metric_alarm" "server_errors" {
  alarm_name          = "${var.name}-catalogue-5xx"
  alarm_description   = "A request was answered with a 5xx within five minutes."
  namespace           = local.metric_namespace
  metric_name         = "ServerErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "auth_failures" {
  alarm_name          = "${var.name}-catalogue-auth-failures"
  alarm_description   = "Ten or more 401 responses in five minutes, which is what password guessing looks like."
  namespace           = local.metric_namespace
  metric_name         = "AuthFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 10
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "unhandled" {
  alarm_name          = "${var.name}-catalogue-unhandled"
  alarm_description   = "The error handler caught something the routes did not expect."
  namespace           = local.metric_namespace
  metric_name         = "Unhandled"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "lockouts" {
  alarm_name          = "${var.name}-catalogue-lockouts"
  alarm_description   = "Three accounts were locked out in fifteen minutes, which is what a password guessing run looks like once the limiter is behind it."
  namespace           = local.metric_namespace
  metric_name         = "Lockouts"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 3
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_metric_alarm" "mail_failures" {
  alarm_name          = "${var.name}-catalogue-mail-failures"
  alarm_description   = "Mail failed to send, so verification links and password resets are not reaching anybody."
  namespace           = local.metric_namespace
  metric_name         = "OutboxFailed"
  statistic           = "Sum"
  period              = 900
  evaluation_periods  = 1
  threshold           = 2
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_ecr_repository" "catalogue" {
  name                 = "${var.name}/catalogue"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

# -----------------------------------------------------------------------------
# IAM: two roles
# -----------------------------------------------------------------------------

locals {
  ses_identity_arn = "arn:aws:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/${var.mail_from}"
}

data "aws_iam_policy_document" "assume_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# The agent uses this before the container starts: pull the image, open the log
# stream, inject the two task secrets. Nothing inside the task sees it.
resource "aws_iam_role" "execution" {
  name               = "${var.name}-catalogue-execution"
  description        = "ECS agent: pull the image, write logs, inject the two task secrets."
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
}

data "aws_iam_policy_document" "execution" {
  # Returns a registry token, not a resource, so it cannot be scoped.
  statement {
    sid       = "EcrToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPull"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [aws_ecr_repository.catalogue.arn]
  }

  statement {
    sid       = "WriteOwnLogGroup"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.app.arn}:*"]
  }

  # Exactly the secrets the task definition references. The signing key is
  # absent on purpose: code fetches it with the task role.
  statement {
    sid     = "InjectTaskSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.database.arn,
      aws_secretsmanager_secret.turnstile.arn,
    ]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "${var.name}-catalogue-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# The credentials the application itself uses.
resource "aws_iam_role" "task" {
  name               = "${var.name}-catalogue-task"
  description        = "The container: read the sealed signing key, decrypt it, send mail."
  assume_role_policy = data.aws_iam_policy_document.assume_tasks.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "ReadTheSealedSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [data.aws_secretsmanager_secret.jwt_signing_key.arn]
  }

  # The key ARN, not the alias ARN: KMS authorises against the key, so an alias
  # ARN looks right and grants nothing.
  statement {
    sid       = "DecryptWithTheKeystoreKey"
    actions   = ["kms:Decrypt"]
    resources = [data.aws_kms_alias.keystore.target_key_arn]
  }

  statement {
    sid       = "SendMailAsTheVerifiedIdentity"
    actions   = ["ses:SendEmail"]
    resources = [local.ses_identity_arn]
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${var.name}-catalogue-task"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# -----------------------------------------------------------------------------
# Front door
# -----------------------------------------------------------------------------

resource "aws_lb" "app" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  internal           = false
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.a.id, aws_subnet.b.id]
}

resource "aws_lb_target_group" "app" {
  name        = "${var.name}-tg"
  port        = var.app_port
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  # Readiness, not liveness: a task that cannot reach the database leaves the
  # rotation instead of being restarted.
  health_check {
    path                = "/readyz"
    matcher             = "200"
    interval            = 15
    timeout             = 3
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

# TLS terminates here, with a self-signed certificate for the demo. On real AWS
# this becomes an ACM-issued certificate and the same listener.
resource "aws_acm_certificate" "dev" {
  certificate_body = file("${path.module}/${var.tls_certificate_path}")
  private_key      = file("${path.module}/${var.tls_private_key_path}")

  lifecycle {
    create_before_destroy = true
  }
}

# No matching host gets a 404, so an unknown address looks like nothing is here.
# There is no HTTP listener: plaintext requests have nowhere to arrive.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = aws_acm_certificate.dev.arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

# Probes are unauthenticated and exempt from rate limiting, so callers get the
# same 404 as an unknown host. Target-group health checks bypass listener rules,
# so the balancer still reaches the task.
resource "aws_lb_listener_rule" "probes_hidden" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 1

  condition {
    path_pattern {
      values = ["/readyz", "/healthz"]
    }
  }

  action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "app_host" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 10

  condition {
    host_header {
      values = var.public_hosts
    }
  }

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# -----------------------------------------------------------------------------
# Task and service
# -----------------------------------------------------------------------------

locals {
  container_name = "app"

  environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "PORT", value = tostring(var.app_port) },
    { name = "LOG_LEVEL", value = "info" },
    { name = "AWS_REGION", value = var.region },
    { name = "AWS_ENDPOINT_URL", value = var.container_endpoint },
    # floci accepts any credentials; on real AWS these three lines go and the
    # task role supplies them.
    { name = "AWS_ACCESS_KEY_ID", value = var.access_key },
    { name = "AWS_SECRET_ACCESS_KEY", value = var.secret_key },
    { name = "AWS_SESSION_TOKEN", value = "test" },
    { name = "KMS_KEY_ALIAS", value = "alias/class-tt-keystore" },
    { name = "JWT_SECRET_ID", value = "class-tt/jwt-signing-key" },
    { name = "MAIL_FROM", value = var.mail_from },
    { name = "PUBLIC_BASE_URL", value = var.public_base_url },
    { name = "MAILER_ENABLED", value = "true" },
    { name = "MAILER_INTERVAL_MS", value = "1000" },
    { name = "RESEND_LIMIT_PER_HOUR", value = "3" },
    { name = "DB_POOL_MAX", value = "5" },
    { name = "RATE_LIMIT_MAX", value = tostring(var.rate_limit_max) },
    { name = "READY_TIMEOUT_MS", value = tostring(var.ready_timeout_ms) },
  ]

  # Credentials, as references: the task definition stores the secret's name,
  # and the agent resolves it at start-up.
  secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database.arn },
    { name = "TURNSTILE_SECRET", valueFrom = aws_secretsmanager_secret.turnstile.arn },
  ]
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.name}-catalogue"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = local.container_name
      image     = var.image
      essential = true

      portMappings = [
        { containerPort = var.app_port, protocol = "tcp" }
      ]

      environment = local.environment
      secrets     = local.secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.region
          "awslogs-stream-prefix" = "app"
        }
      }

      readonlyRootFilesystem = true
      user                   = "1000:1000"
    }
  ])
}

resource "aws_ecs_service" "app" {
  name            = "catalogue"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  # First boot pulls the image and may wake a suspended Neon instance.
  health_check_grace_period_seconds = 60

  network_configuration {
    subnets         = [aws_subnet.a.id, aws_subnet.b.id]
    security_groups = [aws_security_group.app.id]
    # floci has no NAT gateway. On real AWS the tasks go in private subnets and
    # this becomes false.
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = local.container_name
    container_port   = var.app_port
  }

  depends_on = [
    aws_lb_listener_rule.app_host,
    aws_iam_role_policy.execution,
    aws_iam_role_policy.task,
  ]
}

resource "aws_appautoscaling_target" "service" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.id}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.desired_count
  max_capacity       = var.max_count
}

resource "aws_appautoscaling_policy" "requests" {
  name               = "${var.name}-requests"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.service.service_namespace
  resource_id        = aws_appautoscaling_target.service.resource_id
  scalable_dimension = aws_appautoscaling_target.service.scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.target_requests_per_task
    scale_in_cooldown  = 60
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      resource_label         = "${aws_lb.app.arn_suffix}/${aws_lb_target_group.app.arn_suffix}"
    }
  }
}
