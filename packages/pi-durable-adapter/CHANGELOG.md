# Changelog

## [0.11.6](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.11.5...pi-durable-adapter-v0.11.6) (2026-10-24)


### Tests

* **pi-durable:** characterize storage backend parity for the offline candidates ([#1323](https://github.com/adea-ai/control-plane/issues/1323)) ([a705966](https://github.com/adea-ai/control-plane/commit/a70596615d676b6a2343184e038ebe4d2bd37c54))

## [0.11.5](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.11.4...pi-durable-adapter-v0.11.5) (2026-10-24)


### Documentation

* **pi-durable:** reconcile C2/C4/C7 candidate descriptions with merged [#1318](https://github.com/adea-ai/control-plane/issues/1318), [#1319](https://github.com/adea-ai/control-plane/issues/1319), [#1321](https://github.com/adea-ai/control-plane/issues/1321) ([#1322](https://github.com/adea-ai/control-plane/issues/1322)) ([a713a1a](https://github.com/adea-ai/control-plane/commit/a713a1a458f3b596148fde6cb74eb067cc968998))

## [0.11.4](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.11.3...pi-durable-adapter-v0.11.4) (2026-10-24)


### Tests

* **pi-durable-adapter:** offline C7 receipt-ledger same-cut proof ([#1319](https://github.com/adea-ai/control-plane/issues/1319)) ([e628f38](https://github.com/adea-ai/control-plane/commit/e628f386642eda08680359ac3a7292058bac9e47))

## [0.11.3](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.11.2...pi-durable-adapter-v0.11.3) (2026-10-24)


### Tests

* **pi:** cover crash after native cancellation before journal publication ([#1307](https://github.com/adea-ai/control-plane/issues/1307)) ([8265104](https://github.com/adea-ai/control-plane/commit/8265104c0c4ffea5e74586b5863e6799b60f0906))

## [0.11.2](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.11.1...pi-durable-adapter-v0.11.2) (2026-10-24)


### Bug Fixes

* **pi:** classify cancellation publication uncertainty after native commit ([#1305](https://github.com/adea-ai/control-plane/issues/1305)) ([f727f7a](https://github.com/adea-ai/control-plane/commit/f727f7aec45418fda49bd243d13dc1e8ed1b22fc))

## [0.11.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.11.0...pi-durable-adapter-v0.11.1) (2026-10-24)


### Bug Fixes

* reduce dependency closure and preserve budget checks ([#1270](https://github.com/adea-ai/control-plane/issues/1270)) ([01fa230](https://github.com/adea-ai/control-plane/commit/01fa230233cc796b6c7f93d020006212b89631f6))


### Tests

* **profiles:** prove profile recovery and fenced rollback evidence ([#1048](https://github.com/adea-ai/control-plane/issues/1048)) ([da1a38c](https://github.com/adea-ai/control-plane/commit/da1a38cbb4f20da086313451077593d8df3e283d))

## [0.11.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.10.5...pi-durable-adapter-v0.11.0) (2026-10-23)


### Features

* **pi-durable:** compose child reads and drain recovery ([#1204](https://github.com/adea-ai/control-plane/issues/1204)) ([2f1f9d1](https://github.com/adea-ai/control-plane/commit/2f1f9d1a4da48db09e2c8ee9dc08625fbb2bc7a5))

## [0.10.5](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.10.4...pi-durable-adapter-v0.10.5) (2026-10-22)


### Bug Fixes

* **pi-durable:** fence cancellation retries and uncertain effects ([#935](https://github.com/adea-ai/control-plane/issues/935)) ([#1246](https://github.com/adea-ai/control-plane/issues/1246)) ([62d530f](https://github.com/adea-ai/control-plane/commit/62d530f5a4c012e978f38e6880181b8f5fbfebe5))

## [0.10.4](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.10.3...pi-durable-adapter-v0.10.4) (2026-10-19)


### Tests

* **pi:** prove durable input replay and workspace isolation ([#1189](https://github.com/adea-ai/control-plane/issues/1189)) ([a0644a7](https://github.com/adea-ai/control-plane/commit/a0644a7bf5a7e26ee939d4e316d614264d1dadb6))

## [0.10.3](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.10.2...pi-durable-adapter-v0.10.3) (2026-10-17)


### Bug Fixes

* version tool idempotency digests ([#1151](https://github.com/adea-ai/control-plane/issues/1151)) ([9629e97](https://github.com/adea-ai/control-plane/commit/9629e97ae00290876b76eac53fc46b236c4fce1e))

## [0.10.2](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.10.1...pi-durable-adapter-v0.10.2) (2026-10-17)


### Maintenance

* **tooling:** replace Control Plane Turbo with Vite+ and Bun checks ([#1170](https://github.com/adea-ai/control-plane/issues/1170)) ([84e12db](https://github.com/adea-ai/control-plane/commit/84e12dbab1b2fea2380e8747a466db9fb1449959))

## [0.10.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.10.0...pi-durable-adapter-v0.10.1) (2026-10-17)


### Tests

* **pi:** qualify effect receipt gaps across process death ([#1167](https://github.com/adea-ai/control-plane/issues/1167)) ([288a43c](https://github.com/adea-ai/control-plane/commit/288a43c51360fdd53442266044e7277bf2e8a396))

## [0.10.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.9.3...pi-durable-adapter-v0.10.0) (2026-10-16)


### Features

* **models:** surface BYO lead model readiness and recheck it at every boundary ([#1159](https://github.com/adea-ai/control-plane/issues/1159)) ([83265a6](https://github.com/adea-ai/control-plane/commit/83265a66057006b0ce44f5b24959f871de84e394))

## [0.9.3](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.9.2...pi-durable-adapter-v0.9.3) (2026-10-16)


### Tests

* **pi:** qualify governed child dispatch after native compaction and reopen ([#1134](https://github.com/adea-ai/control-plane/issues/1134)) ([0a453d8](https://github.com/adea-ai/control-plane/commit/0a453d83103a787bdcc6c38a6571de9188f7f559))

## [0.9.2](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.9.1...pi-durable-adapter-v0.9.2) (2026-10-14)


### Tests

* **pi:** qualify child admission after native compaction ([#1127](https://github.com/adea-ai/control-plane/issues/1127)) ([1500ebb](https://github.com/adea-ai/control-plane/commit/1500ebb9cc05d61f9d19189986e1060cd48204e0))

## [0.9.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.9.0...pi-durable-adapter-v0.9.1) (2026-10-14)


### Bug Fixes

* **pi-durable:** preflight retained approval tool pins ([#1124](https://github.com/adea-ai/control-plane/issues/1124)) ([128b396](https://github.com/adea-ai/control-plane/commit/128b396eca07f45185c6abf2ab476612b922968a))

## [0.9.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.8.0...pi-durable-adapter-v0.9.0) (2026-10-13)


### Features

* **orchestration:** retain governed Pi child mappings and recovery proofs ([#1111](https://github.com/adea-ai/control-plane/issues/1111)) ([ba0846d](https://github.com/adea-ai/control-plane/commit/ba0846d5fd6a4919d9e80fae7cca05b60427e57c))

## [0.8.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.7.1...pi-durable-adapter-v0.8.0) (2026-10-12)


### Features

* coalesce child progress into bounded evidence packets ([#973](https://github.com/adea-ai/control-plane/issues/973)) ([0df9d17](https://github.com/adea-ai/control-plane/commit/0df9d17ec3b0e167e081ad8a056bc2f21a194ccd))
* **pi:** add typed retained approval-write task over the effect gate ([#939](https://github.com/adea-ai/control-plane/issues/939)) ([#1065](https://github.com/adea-ai/control-plane/issues/1065)) ([6e77203](https://github.com/adea-ai/control-plane/commit/6e772034516d31f3a7ddd0474b7c41cfc42f38a7))

## [0.7.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.7.0...pi-durable-adapter-v0.7.1) (2026-10-11)


### Bug Fixes

* **control-api:** pin production BYO model eligibility to the Pi catalog ([#1079](https://github.com/adea-ai/control-plane/issues/1079)) ([fceb920](https://github.com/adea-ai/control-plane/commit/fceb920bc1b7401385f6e1b23b0e4a66f365a740)), refs [#931](https://github.com/adea-ai/control-plane/issues/931) (remaining scope is open)

## [0.7.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.6.1...pi-durable-adapter-v0.7.0) (2026-10-10)


### Features

* **operations:** audited admission controls, stuck-job inspection, retirement gates ([#1052](https://github.com/adea-ai/control-plane/issues/1052)) ([7451dec](https://github.com/adea-ai/control-plane/commit/7451dec27386f0ebde2edebbb2e01b670ccb44c0))

## [0.6.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.6.0...pi-durable-adapter-v0.6.1) (2026-10-10)


### Tests

* **pi-durable:** register secret canaries for journal and lead-preparation sinks ([#1059](https://github.com/adea-ai/control-plane/issues/1059)) ([b5bec50](https://github.com/adea-ai/control-plane/commit/b5bec5075ef0fa0e99f3e368961479883a5f5842))

## [0.6.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.5.0...pi-durable-adapter-v0.6.0) (2026-10-10)


### Features

* issue-932-management-current-authority ([#1043](https://github.com/adea-ai/control-plane/issues/1043)) ([3118a7c](https://github.com/adea-ai/control-plane/commit/3118a7c9f5d177a3fdce2de8ced7fbf353d91e43))

## [0.5.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.4.1...pi-durable-adapter-v0.5.0) (2026-10-09)


### Features

* **pi:** 935 cancel-intent persistence, attempt fencing, and target-bound observation ([#1045](https://github.com/adea-ai/control-plane/issues/1045)) ([1208729](https://github.com/adea-ai/control-plane/commit/12087297deac41190f52f629d70e40bdb8d50d01))

## [0.4.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.4.0...pi-durable-adapter-v0.4.1) (2026-10-09)


### Bug Fixes

* **pi:** fence cancellation by inference generation ([#1031](https://github.com/adea-ai/control-plane/issues/1031)) ([f735d7e](https://github.com/adea-ai/control-plane/commit/f735d7eae4f6b909c53a7bb4b6b4f8ef1769c9b7))

## [0.4.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.3.0...pi-durable-adapter-v0.4.0) (2026-10-09)


### Features

* compose production Pi lead model and publication authority ([#996](https://github.com/adea-ai/control-plane/issues/996)) ([1332100](https://github.com/adea-ai/control-plane/commit/13321009f6e9d7984a8774df8818e1b775c582ea))


### Bug Fixes

* **pi:** fence continuation retention on current child journal ([#1007](https://github.com/adea-ai/control-plane/issues/1007)) ([b237e7a](https://github.com/adea-ai/control-plane/commit/b237e7a034a0687bd5f1ed7489c7225085e8b17d))


### Tests

* specify unfinished Pi child process recovery proofs ([#979](https://github.com/adea-ai/control-plane/issues/979)) ([6b82ccd](https://github.com/adea-ai/control-plane/commit/6b82ccd677e69eca14d765ac77d9d273df228d42))

## [0.3.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.2.1...pi-durable-adapter-v0.3.0) (2026-10-08)


### Features

* pi-child-continuation ([#981](https://github.com/adea-ai/control-plane/issues/981)) ([a9d8228](https://github.com/adea-ai/control-plane/commit/a9d8228d70ee6eb6234204c24c9b46dc2fc38d7a))

## [0.2.1](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.2.0...pi-durable-adapter-v0.2.1) (2026-10-08)


### Tests

* keep Pi interruption worker alive until signalled ([#984](https://github.com/adea-ai/control-plane/issues/984)) ([e5a224a](https://github.com/adea-ai/control-plane/commit/e5a224ab60fa98dfad629186bcc23727c9fcc612))

## [0.2.0](https://github.com/adea-ai/control-plane/compare/pi-durable-adapter-v0.1.0...pi-durable-adapter-v0.2.0) (2026-10-08)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))
* **pi-durable:** add persistent governed Node runtime and funded lead admission ([#949](https://github.com/adea-ai/control-plane/issues/949)) ([2ad205f](https://github.com/adea-ai/control-plane/commit/2ad205f783c09a0cc7e208d5c799d6c18636500a))


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))
