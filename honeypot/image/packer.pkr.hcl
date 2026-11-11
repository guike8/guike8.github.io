packer {
  required_version = ">= 1.13.0"

  required_plugins {
    digitalocean = {
      source  = "github.com/digitalocean/digitalocean"
      version = "= 1.4.1"
    }
  }
}

variable "digitalocean_token" {
  type      = string
  default   = env("DIGITALOCEAN_TOKEN")
  sensitive = true
}

variable "source_directory" {
  type        = string
  description = "Absolute path to a sanitized staging directory containing the honeypot root, never a live deployment or working checkout with secrets."
}

variable "region" {
  type    = string
  default = "nyc3"
}

variable "size" {
  type    = string
  default = "s-1vcpu-1gb"
}

variable "base_image" {
  type        = string
  default     = "ubuntu-24-04-x64"
  description = "DigitalOcean Ubuntu 24.04 image slug, or an explicit supported image ID for a fixed base."
}

variable "source_revision" {
  type        = string
  default     = "unrecorded"
  description = "Source commit or release identifier; non-secret build provenance."
}

locals {
  source_root = abspath(var.source_directory)
  build_stamp = formatdate("YYYYMMDD-hhmmss", timestamp())
}

source "digitalocean" "nightjar" {
  api_token        = var.digitalocean_token
  image            = var.base_image
  region           = var.region
  size             = var.size
  ssh_username     = "root"
  ssh_port         = 22
  ssh_timeout      = "15m"
  droplet_name     = "nightjar-image-builder-${local.build_stamp}"
  snapshot_name    = "nightjar-ubuntu2404-${local.build_stamp}"
  state_timeout    = "15m"
  snapshot_timeout = "90m"
  droplet_agent    = false
  monitoring       = false
  ipv6             = false
  tags             = ["nightjar-image-builder"]
  snapshot_tags    = ["nightjar", "nightjar-golden-image"]

  # The temporary builder accepts only key authentication. It does not run decoys.
  # Do not supply this build account's token, keys, or launch credentials as user data.
  user_data = "#cloud-config\nssh_pwauth: false\n"
}

build {
  name    = "nightjar-snapshot"
  sources = ["source.digitalocean.nightjar"]

  provisioner "shell" {
    inline = [
      "set -eu",
      "cloud-init status --wait",
      "test ! -e /opt/nightjar/state",
      "install -d -m 0755 /opt/nightjar",
      "touch /run/nightjar-image-build"
    ]
  }

  # A trailing slash uploads the staged directory's contents, not its parent.
  provisioner "file" {
    source      = "${local.source_root}/"
    destination = "/opt/nightjar/"
  }

  provisioner "shell" {
    environment_vars = ["NIGHTJAR_IMAGE_BUILD=1"]
    inline = [
      "set -eu",
      "test -f /opt/nightjar/scripts/install-image.sh",
      "bash /opt/nightjar/scripts/install-image.sh"
    ]
  }

  # Last SSH provisioning step. Cleanup removes the temporary login key and
  # host identity only after every install/verification command has finished.
  # No restart, reboot, or subsequent SSH provisioner may follow this step.
  provisioner "shell" {
    environment_vars = ["NIGHTJAR_IMAGE_BUILD=1"]
    script           = "${path.root}/cleanup.sh"
    skip_clean       = true
  }

  post-processor "manifest" {
    output     = "${path.root}/manifest.json"
    strip_path = true
    custom_data = {
      source_revision = var.source_revision
      base_image      = var.base_image
      region          = var.region
      build_size      = var.size
      artifact_kind   = "digitalocean-snapshot"
    }
  }
}
