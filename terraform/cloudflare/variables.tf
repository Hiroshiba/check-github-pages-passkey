variable "cloudflare_account_id" {
  description = "承認用 Worker と Zero Trust を所有する Cloudflare account ID"
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id には32文字の小文字16進数を指定してください"
  }
}
