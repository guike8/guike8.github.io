# Nightjar VPS image

This Packer template creates a **reusable DigitalOcean snapshot** with the application and container images installed. It creates a temporary, billable builder Droplet, provisions it without starting any honeypot services, removes per-instance state and credentials, and asks DigitalOcean to snapshot the disk. Packer normally removes its temporary builder and temporary account SSH key after completion. A failed or interrupted build can leave resources; inspect the account before retrying. The snapshot remains billable until deleted.

The image includes pinned Beelzebub v3.10.0 for HTTP decoys, its sanitized telemetry supervisor, the canonical homepage, Cowrie SSH emulation, the bounded upload receiver and private console. Beelzebub is built from a checksum-verified source archive; the binary's upstream source and GPL license are included in its container.

A snapshot is an image in your DigitalOcean account. This workflow does **not** produce a portable `.qcow2`, ISO, or local disk-image download, and it does not import a file through the Custom Images uploader.

## Build inputs

- Packer 1.13 or newer; the DigitalOcean plugin is pinned to `1.4.1`.
- A DigitalOcean account with permission to create/delete the builder and temporary SSH key and create snapshots/tags.
- A sanitized staging directory containing the **contents of `honeypot/`**, including `scripts/install-image.sh`. Use the repository's image-context preparation script; never point Packer at a running deployment or an unchecked source directory.
- The account token supplied only as `DIGITALOCEAN_TOKEN` in the launching process environment. The template marks this value sensitive. Do not put it in a `.pkrvars.hcl` file, CLI argument, committed config, or shell history. Do not enable debug/trace logs containing credentials.

Defaults are Ubuntu 24.04 LTS x64 (`ubuntu-24-04-x64`), `nyc3`, and `s-1vcpu-1gb`. Region, build size, base image, and source revision are configurable. The Ubuntu slug tracks DigitalOcean updates; pass an explicit supported image ID when a fixed base is required.

Once the sanitized context exists, run from the repository root:

```sh
packer init honeypot/image
packer fmt -check honeypot/image
packer validate -var 'source_directory=/absolute/path/to/sanitized/image-context' honeypot/image
packer build -var 'source_directory=/absolute/path/to/sanitized/image-context' \
  -var "source_revision=$(git rev-parse HEAD)" honeypot/image
```

The commands assume the token is already available securely in the process environment. The source path and Git revision are not secrets. Validation does not create a Droplet; `build` creates billable cloud resources. `manifest.json` records the resulting snapshot artifact ID and source/base identifiers. Keep that build record private to the operator.

Alternatively, `bash honeypot/scripts/build-image.sh` prepares a temporary sanitized context, initializes and validates Packer, and builds the snapshot. If the API token is not already in the environment, it prompts with hidden input and does not save the value. `PACKER_BIN` can point to a verified local Packer executable. This command creates the same billable resources described above.

The builder uses SSH port 22 during installation. The installed image configures management SSH on 22222 for launches; it must not restart the builder's SSH service during provisioning. Final cleanup removes the temporary authorized key and all SSH host keys, resets cloud-init and machine identity, and removes `state/`, `.secrets/`, `.env`, and any quarantine image. Never execute `cleanup.sh` on a collecting server. Its builder marker and environment checks intentionally reject ordinary use.

## Launch a snapshot

1. Select the resulting image under **Snapshots** when creating the new Droplet. Use a region holding the snapshot and a plan with a disk at least as large as its minimum disk size.
2. Select **your own SSH public key** for the new Droplet. No operator credential is baked into the image.
3. Attach the reviewed cloud firewall before exposing the server. Permit management TCP 22222 only from your administrative IP range, and permit the chosen public honeypot ports. Keep the console loopback-only.
4. Let cloud-init and the installed first-boot service finish. They generate new SSH host keys, console token, and runtime storage, then start the prepared stack. Do not clone a live collector to make more images.
5. Connect using `ssh -p 22222 root@SERVER_IP`. Open the dashboard using the documented SSH tunnel. Check ingestion and perform the bounded smoke checks before treating the deployment as ready.

## If you need an importable QCOW2 instead

Build a separate BIOS-bootable x86-64 disk locally or in a trusted VM builder, then import it as a DigitalOcean Custom Image. Do not rename a snapshot ID or an archive of source files to `.qcow2`.

DigitalOcean currently accepts raw (`.img` with MBR/GPT), QCOW2, VHDX, VDI, and VMDK images. Uploaded images need a Unix-like OS, ext3/ext4 support, an uncompressed size **below 100 GB**, working DHCP, an SSH daemon enabled at boot, and correctly configured cloud-init (at least 0.7.7). Custom Images require **BIOS** boot, not UEFI. If `NoCloud` is present in the datasource list, it must follow `ConfigDrive`. Reset all build identity and metadata before capturing the disk, and select an SSH public key at Droplet creation.

For imported Custom Images, DigitalOcean documents no IPv6 support and no automatic monitoring enablement during creation. If a cloud firewall restricts egress, allow outbound UDP 67 for DHCP. URL imports require a downloadable image URL whose server supports HEAD requests; the uploader also accepts a local file. These import constraints do not turn the snapshot workflow above into a portable image exporter.

## Verified references

- [Packer DigitalOcean builder and configuration](https://developer.hashicorp.com/packer/integrations/digitalocean/digitalocean/latest/components/builder/digitalocean)
- [Current DigitalOcean Linux image slugs](https://docs.digitalocean.com/products/droplets/details/images/)
- [DigitalOcean Custom Image requirements and upload](https://docs.digitalocean.com/products/custom-images/how-to/upload/)
- [Custom Image platform limits](https://docs.digitalocean.com/products/custom-images/details/limits/)
- [Creating Droplets from Custom Images](https://docs.digitalocean.com/products/custom-images/how-to/create-droplets/)
