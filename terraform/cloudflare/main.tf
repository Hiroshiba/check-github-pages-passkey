locals {
  approval_destination         = "github-pages-deployment-approval.voicevox-oss.workers.dev/approval/authorize/*"
  approval_session_duration    = "15m"
  organization_session_default = "24h"
  worker_configuration         = jsondecode(file("${path.module}/../../wrangler.jsonc"))
  access_auth_domain           = trimprefix(local.worker_configuration.vars.ACCESS_TEAM_DOMAIN, "https://")
  approver_emails              = toset(local.worker_configuration.vars.ALLOWED_APPROVER_EMAILS)
  configured_access_aud        = local.worker_configuration.vars.ACCESS_AUD
  configured_kv_namespace_id = one([
    for namespace in local.worker_configuration.kv_namespaces : namespace.id
    if namespace.binding == "DEPLOYMENT_REQUESTS"
  ])
}

data "cloudflare_zero_trust_organization" "existing" {
  account_id = var.cloudflare_account_id
}

resource "cloudflare_zero_trust_organization" "approval" {
  account_id                                  = var.cloudflare_account_id
  allow_authenticate_via_warp                 = data.cloudflare_zero_trust_organization.existing.allow_authenticate_via_warp
  auth_domain                                 = data.cloudflare_zero_trust_organization.existing.auth_domain
  auto_redirect_to_identity                   = data.cloudflare_zero_trust_organization.existing.auto_redirect_to_identity
  custom_pages                                = data.cloudflare_zero_trust_organization.existing.custom_pages
  deny_unmatched_requests                     = data.cloudflare_zero_trust_organization.existing.deny_unmatched_requests
  deny_unmatched_requests_exempted_zone_names = data.cloudflare_zero_trust_organization.existing.deny_unmatched_requests_exempted_zone_names
  is_ui_read_only                             = data.cloudflare_zero_trust_organization.existing.is_ui_read_only
  login_design                                = data.cloudflare_zero_trust_organization.existing.login_design
  mfa_config = {
    allowed_authenticators = ["biometrics"]
    session_duration       = local.organization_session_default
  }
  mfa_required_for_all_apps          = false
  mfa_ssh_piv_key_requirements       = data.cloudflare_zero_trust_organization.existing.mfa_ssh_piv_key_requirements
  name                               = data.cloudflare_zero_trust_organization.existing.name
  session_duration                   = local.organization_session_default
  ui_read_only_toggle_reason         = data.cloudflare_zero_trust_organization.existing.ui_read_only_toggle_reason
  user_seat_expiration_inactive_time = data.cloudflare_zero_trust_organization.existing.user_seat_expiration_inactive_time
  warp_auth_session_duration         = data.cloudflare_zero_trust_organization.existing.warp_auth_session_duration

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = data.cloudflare_zero_trust_organization.existing.auth_domain == local.access_auth_domain
      error_message = "Cloudflare account の Zero Trust team domain が wrangler.jsonc と一致しません"
    }
  }
}

resource "cloudflare_zero_trust_access_identity_provider" "one_time_pin" {
  account_id = var.cloudflare_account_id
  config     = {}
  name       = "承認者用 One-time PIN"
  type       = "onetimepin"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "mfa_enrollment" {
  account_id = var.cloudflare_account_id
  decision   = "allow"
  include = [
    for email in local.approver_emails : {
      email = { email = email }
    }
  ]
  name             = "GitHub Pages 承認者 MFA 登録"
  session_duration = local.approval_session_duration

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "approval" {
  account_id = var.cloudflare_account_id
  decision   = "allow"
  include = [
    for email in local.approver_emails : {
      email = { email = email }
    }
  ]
  mfa_config = {
    allowed_authenticators = ["biometrics"]
    mfa_disabled           = false
    session_duration       = local.approval_session_duration
  }
  name             = "GitHub Pages デプロイ承認者"
  session_duration = local.approval_session_duration

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "app_launcher" {
  account_id                = var.cloudflare_account_id
  allowed_idps              = [cloudflare_zero_trust_access_identity_provider.one_time_pin.id]
  auto_redirect_to_identity = true
  name                      = "承認者用 App Launcher"
  policies = [{
    id         = cloudflare_zero_trust_access_policy.mfa_enrollment.id
    precedence = 1
  }]
  session_duration = local.approval_session_duration
  type             = "app_launcher"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "approval" {
  account_id                  = var.cloudflare_account_id
  allow_authenticate_via_warp = false
  allowed_idps                = [cloudflare_zero_trust_access_identity_provider.one_time_pin.id]
  app_launcher_visible        = false
  auto_redirect_to_identity   = true
  destinations = [{
    type = "public"
    uri  = local.approval_destination
  }]
  domain                = local.approval_destination
  name                  = "GitHub Pages デプロイ承認"
  path_cookie_attribute = true
  policies = [{
    id         = cloudflare_zero_trust_access_policy.approval.id
    precedence = 1
  }]
  session_duration = local.approval_session_duration
  type             = "self_hosted"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_kv_namespace" "deployment_requests" {
  account_id = var.cloudflare_account_id
  title      = "github-pages-deployment-approval-deployment-requests"

  lifecycle {
    prevent_destroy = true
  }
}
