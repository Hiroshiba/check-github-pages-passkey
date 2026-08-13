check "access_aud_matches_wrangler" {
  assert {
    condition     = cloudflare_zero_trust_access_application.approval.aud == local.configured_access_aud
    error_message = "Terraform の access_aud を wrangler.jsonc の ACCESS_AUD に反映して Worker を再デプロイしてください"
  }
}

check "kv_namespace_matches_wrangler" {
  assert {
    condition     = cloudflare_workers_kv_namespace.deployment_requests.id == local.configured_kv_namespace_id
    error_message = "Terraform の deployment_requests_kv_namespace_id を wrangler.jsonc の KV namespace ID に反映して Worker を再デプロイしてください"
  }
}

output "access_aud" {
  description = "wrangler.jsonc の ACCESS_AUD に設定する値"
  value       = cloudflare_zero_trust_access_application.approval.aud
}

output "approval_url" {
  description = "Cloudflare Access が保護する承認 URL"
  value       = "https://${trimsuffix(local.approval_destination, "/*")}"
}

output "deployment_requests_kv_namespace_id" {
  description = "wrangler.jsonc の DEPLOYMENT_REQUESTS binding に設定する namespace ID"
  value       = cloudflare_workers_kv_namespace.deployment_requests.id
}
