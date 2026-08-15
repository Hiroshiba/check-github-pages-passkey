locals {
  infrastructure_configuration = jsondecode(file("${path.module}/../settings.json"))
  worker_configuration         = jsondecode(file("${path.module}/../../wrangler.jsonc"))
  repository_parts             = split("/", local.worker_configuration.vars.ALLOWED_REPOSITORY)
  repository_owner             = local.repository_parts[0]
  repository_name              = local.repository_parts[1]
  reviewer_logins              = toset(local.infrastructure_configuration.github_environment_reviewer_logins)
  reviewed_environment_names = toset([
    "cloudflare-plan",
    "cloudflare-production",
    "github-plan",
    "github-production",
  ])
}

data "github_repository" "target" {
  full_name = local.worker_configuration.vars.ALLOWED_REPOSITORY
}

data "github_user" "reviewer" {
  for_each = local.reviewer_logins
  username = each.value
}

check "repository_configuration" {
  assert {
    condition     = length(local.repository_parts) == 2
    error_message = "wrangler.jsonc の ALLOWED_REPOSITORY は owner/name 形式で指定してください"
  }

  assert {
    condition     = data.github_repository.target.visibility == "public"
    error_message = "対象 GitHub repository は Public にしてください"
  }

  assert {
    condition     = tostring(data.github_repository.target.repo_id) == local.worker_configuration.vars.ALLOWED_REPOSITORY_ID
    error_message = "GitHub repository ID が wrangler.jsonc の ALLOWED_REPOSITORY_ID と一致しません"
  }
}

check "infrastructure_configuration" {
  assert {
    condition     = can(regex("^[0-9a-f]{32}$", local.infrastructure_configuration.cloudflare_account_id))
    error_message = "terraform/settings.json の cloudflare_account_id には32文字の小文字16進数を指定してください"
  }

  assert {
    condition     = length(local.reviewer_logins) >= 1 && length(local.reviewer_logins) <= 6
    error_message = "github_environment_reviewer_logins には1人以上6人以下の GitHub login を指定してください"
  }

  assert {
    condition = alltrue([
      for login in local.reviewer_logins : can(regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?$", login)) && !startswith(login, "replace-with-")
    ])
    error_message = "github_environment_reviewer_logins に有効な GitHub login を指定してください"
  }

  assert {
    condition     = length(local.reviewer_logins) == length(local.infrastructure_configuration.github_environment_reviewer_logins)
    error_message = "github_environment_reviewer_logins に同じ GitHub login を重複して指定しないでください"
  }
}

resource "github_branch_default" "main" {
  repository = local.repository_name
  branch     = "main"

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_branch" "production" {
  repository    = local.repository_name
  branch        = "production"
  source_branch = github_branch_default.main.branch

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_ruleset" "production" {
  name        = "production を固定する"
  repository  = local.repository_name
  target      = "branch"
  enforcement = "active"

  conditions {
    ref_name {
      include = [github_branch.production.ref]
      exclude = []
    }
  }

  rules {
    creation         = true
    update           = true
    deletion         = true
    non_fast_forward = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_pages" "site" {
  repository = local.repository_name
  build_type = "workflow"

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_environment" "github_pages" {
  repository          = local.repository_name
  environment         = "github-pages"
  can_admins_bypass   = false
  prevent_self_review = false

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_environment" "reviewed" {
  for_each            = local.reviewed_environment_names
  repository          = local.repository_name
  environment         = each.value
  can_admins_bypass   = false
  prevent_self_review = true

  reviewers {
    users = [for reviewer in data.github_user.reviewer : reviewer.id]
  }

  deployment_branch_policy {
    protected_branches     = false
    custom_branch_policies = true
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_environment_deployment_policy" "github_pages" {
  repository     = local.repository_name
  environment    = github_repository_environment.github_pages.environment
  branch_pattern = github_branch.production.branch

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_repository_environment_deployment_policy" "reviewed" {
  for_each       = local.reviewed_environment_names
  repository     = local.repository_name
  environment    = github_repository_environment.reviewed[each.key].environment
  branch_pattern = github_branch.production.branch

  lifecycle {
    prevent_destroy = true
  }
}

resource "github_actions_variable" "cloudflare_account_id" {
  repository    = local.repository_name
  variable_name = "CLOUDFLARE_ACCOUNT_ID"
  value         = local.infrastructure_configuration.cloudflare_account_id

  lifecycle {
    prevent_destroy = true
  }
}
