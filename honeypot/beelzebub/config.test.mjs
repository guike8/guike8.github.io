import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfigurations, TRUSTED_PROXY } from './generate-config.mjs';

test('canonical homepage bytes survive configuration generation at both public paths', () => {
  const homepage = Buffer.from('<!doctype html>\n<title>guike8</title>\n㇏(•̀ᵥᵥ•́)ノ\n');
  const { service } = buildConfigurations(homepage);
  const root = service.commands[0];
  assert.ok(new RegExp(root.regex).test('/'));
  assert.ok(new RegExp(root.regex).test('/index.html'));
  assert.ok(new RegExp(root.regex).test('/?from=github'));
  assert.ok(!new RegExp(root.regex).test('/index.html/else'));
  assert.deepEqual(Buffer.from(root.handler), homepage);
  assert.deepEqual(Buffer.from(JSON.parse(JSON.stringify(service)).commands[0].handler), homepage);
});

test('configuration disables raw log files, external reporting, metrics, and dynamic plugins', () => {
  const { core, service } = buildConfigurations('homepage');
  assert.equal(core.core.logging.logsPath, '');
  assert.equal(core.core.logging.debug, false);
  assert.equal(core.core.prometheus.enabled, false);
  assert.equal(core.core.tracings['rabbit-mq'].enabled, false);
  assert.equal(core.core['beelzebub-cloud'].enabled, false);
  assert.deepEqual(service.trustedProxies, [TRUSTED_PROXY]);
  assert.ok(service.commands.every(command => !command.plugin));
  assert.ok(!service.fallbackCommand.plugin);
  assert.ok(service.commands.every(command => /^(authentication|reconnaissance|exploitation|discovery|artifact):[1-5][0-9]{2}$/.test(command.name)));
  assert.equal(service.fallbackCommand.name, 'discovery:404');
});

test('homepage source is bounded valid canonical UTF-8', () => {
  assert.throws(() => buildConfigurations(Buffer.alloc(0)));
  assert.throws(() => buildConfigurations(Buffer.alloc(262145)));
  assert.throws(() => buildConfigurations(Buffer.from([0xff])));
  assert.throws(() => buildConfigurations(Buffer.from([0xef, 0xbb, 0xbf, 0x61])));
});
