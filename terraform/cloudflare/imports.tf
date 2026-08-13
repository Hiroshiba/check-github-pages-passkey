locals {
  existing_app_launchers = [
    for application in data.cloudflare_zero_trust_access_applications.existing.result : application
    if application.type == "app_launcher"
  ]
  existing_approval_applications = [
    for application in data.cloudflare_zero_trust_access_applications.existing.result : application
    if application.aud == local.configured_access_aud || application.domain == local.approval_destination
  ]
  existing_one_time_pin_identity_providers = [
    for identity_provider in data.cloudflare_zero_trust_access_identity_providers.existing.result : identity_provider
    if identity_provider.type == "onetimepin"
  ]
  existing_mfa_enrollment_policies = [
    for policy in data.cloudflare_zero_trust_access_policies.existing.result : policy
    if policy.name == "GitHub Pages 承認者 MFA 登録" && policy.reusable
  ]
  existing_approval_policies = [
    for policy in data.cloudflare_zero_trust_access_policies.existing.result : policy
    if policy.name == "GitHub Pages デプロイ承認者" && policy.reusable
  ]
  existing_deployment_request_namespaces = [
    for namespace in data.cloudflare_workers_kv_namespaces.existing.result : namespace
    if namespace.id == local.configured_kv_namespace_id
  ]
}

check "app_launcher_is_unique" {
  assert {
    condition     = length(local.existing_app_launchers) <= 1
    error_message = "App Launcher が複数あります。管理対象を一意にできません"
  }
}

check "approval_application_is_unique" {
  assert {
    condition     = length(local.existing_approval_applications) <= 1
    error_message = "承認用 Access Application が複数あります。AUD と保護対象を確認してください"
  }
}

check "one_time_pin_is_unique" {
  assert {
    condition     = length(local.existing_one_time_pin_identity_providers) <= 1
    error_message = "One-time PIN identity provider が複数あります。管理対象を一意にできません"
  }
}

check "mfa_enrollment_policy_is_unique" {
  assert {
    condition     = length(local.existing_mfa_enrollment_policies) <= 1
    error_message = "承認者 MFA 登録 policy が複数あります。管理対象を一意にできません"
  }
}

check "approval_policy_is_unique" {
  assert {
    condition     = length(local.existing_approval_policies) <= 1
    error_message = "デプロイ承認者 policy が複数あります。管理対象を一意にできません"
  }
}

import {
  for_each = {
    for application in local.existing_app_launchers : application.id => application
  }
  id = "accounts/${var.cloudflare_account_id}/${each.key}"
  to = cloudflare_zero_trust_access_application.app_launcher
}

import {
  for_each = {
    for application in local.existing_approval_applications : application.id => application
  }
  id = "accounts/${var.cloudflare_account_id}/${each.key}"
  to = cloudflare_zero_trust_access_application.approval
}

import {
  for_each = {
    for identity_provider in local.existing_one_time_pin_identity_providers : identity_provider.id => identity_provider
  }
  id = "accounts/${var.cloudflare_account_id}/${each.key}"
  to = cloudflare_zero_trust_access_identity_provider.one_time_pin
}

import {
  for_each = {
    for policy in local.existing_mfa_enrollment_policies : policy.id => policy
  }
  id = "${var.cloudflare_account_id}/${each.key}"
  to = cloudflare_zero_trust_access_policy.mfa_enrollment
}

import {
  for_each = {
    for policy in local.existing_approval_policies : policy.id => policy
  }
  id = "${var.cloudflare_account_id}/${each.key}"
  to = cloudflare_zero_trust_access_policy.approval
}

import {
  for_each = {
    for namespace in local.existing_deployment_request_namespaces : namespace.id => namespace
  }
  id = "${var.cloudflare_account_id}/${each.key}"
  to = cloudflare_workers_kv_namespace.deployment_requests
}
