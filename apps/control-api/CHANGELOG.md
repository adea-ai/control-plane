# Changelog

## [1.36.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.36.0...control-api-v1.36.1) (2026-10-24)


### Bug Fixes

* reduce dependency closure and preserve budget checks ([#1270](https://github.com/adea-ai/control-plane/issues/1270)) ([01fa230](https://github.com/adea-ai/control-plane/commit/01fa230233cc796b6c7f93d020006212b89631f6))


### Tests

* **profiles:** prove profile recovery and fenced rollback evidence ([#1048](https://github.com/adea-ai/control-plane/issues/1048)) ([da1a38c](https://github.com/adea-ai/control-plane/commit/da1a38cbb4f20da086313451077593d8df3e283d))

## [1.36.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.35.0...control-api-v1.36.0) (2026-10-23)


### Features

* **pi-durable:** compose child reads and drain recovery ([#1204](https://github.com/adea-ai/control-plane/issues/1204)) ([2f1f9d1](https://github.com/adea-ai/control-plane/commit/2f1f9d1a4da48db09e2c8ee9dc08625fbb2bc7a5))

## [1.35.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.7...control-api-v1.35.0) (2026-10-23)


### Features

* **context:** qualify decision context consumers ([#558](https://github.com/adea-ai/control-plane/issues/558)) ([#1218](https://github.com/adea-ai/control-plane/issues/1218)) ([77b93eb](https://github.com/adea-ai/control-plane/commit/77b93eb77603b462a01094b6916479318c844018))

## [1.34.7](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.6...control-api-v1.34.7) (2026-10-23)


### Tests

* **control-api:** prove the immutable configuration binding and the approval replay for CP [#932](https://github.com/adea-ai/control-plane/issues/932) ([#1226](https://github.com/adea-ai/control-plane/issues/1226)) ([b513d54](https://github.com/adea-ai/control-plane/commit/b513d547cfa03b30e8ebea29752546dca13144ca))

## [1.34.6](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.5...control-api-v1.34.6) (2026-10-22)


### Tests

* **#1018:** prove the concurrent retry and a client reconnect on PostgreSQL ([#1252](https://github.com/adea-ai/control-plane/issues/1252)) ([9789445](https://github.com/adea-ai/control-plane/commit/9789445e7f73dbe5ad3d06bee5873be54ad750fc))

## [1.34.5](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.4...control-api-v1.34.5) (2026-10-22)


### Bug Fixes

* **railway:** verify production PostgreSQL identity and scoped migrations ([#1256](https://github.com/adea-ai/control-plane/issues/1256)) ([86b7515](https://github.com/adea-ai/control-plane/commit/86b751520c569106644c518dd5fd0819056cd169))

## [1.34.4](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.3...control-api-v1.34.4) (2026-10-22)


### Bug Fixes

* **pi-durable:** fence cancellation retries and uncertain effects ([#935](https://github.com/adea-ai/control-plane/issues/935)) ([#1246](https://github.com/adea-ai/control-plane/issues/1246)) ([62d530f](https://github.com/adea-ai/control-plane/commit/62d530f5a4c012e978f38e6880181b8f5fbfebe5))


### Maintenance

* pin Bun 1.4.4 and use native SDK consumer checking ([#1255](https://github.com/adea-ai/control-plane/issues/1255)) ([176d2d6](https://github.com/adea-ai/control-plane/commit/176d2d61571ef89263e017ddb911b4315aa07234))

## [1.34.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.2...control-api-v1.34.3) (2026-10-21)


### Bug Fixes

* **control-api:** refuse the funding disclosure when the funding host is absent ([019b5fe](https://github.com/adea-ai/control-plane/commit/019b5fec91525a9adc152ea8bc605113c34865cf))
* **control-api:** refuse the funding disclosure when the funding host is absent (CP [#931](https://github.com/adea-ai/control-plane/issues/931)) ([#1229](https://github.com/adea-ai/control-plane/issues/1229)) ([019b5fe](https://github.com/adea-ai/control-plane/commit/019b5fec91525a9adc152ea8bc605113c34865cf))

## [1.34.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.1...control-api-v1.34.2) (2026-10-20)


### Maintenance

* **deps:** update dependency @opentelemetry/sdk-metrics to v3 ([#1206](https://github.com/adea-ai/control-plane/issues/1206)) ([6ca4635](https://github.com/adea-ai/control-plane/commit/6ca46356510243d7a3752299dcd6ff076bb7bbd8))

## [1.34.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.34.0...control-api-v1.34.1) (2026-10-20)


### Tests

* **pi-restart:** prove lead run recovery across a real process restart ([#1200](https://github.com/adea-ai/control-plane/issues/1200)) ([20ff342](https://github.com/adea-ai/control-plane/commit/20ff342b707eea21486dcf4e0cb719a5b1d9c618))

## [1.34.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.33.3...control-api-v1.34.0) (2026-10-18)


### Features

* **pi:** disclose the lead plan's child allowance on preparation ([#1211](https://github.com/adea-ai/control-plane/issues/1211)) ([#1136](https://github.com/adea-ai/control-plane/issues/1136)) ([efd457a](https://github.com/adea-ai/control-plane/commit/efd457a36911ee58674a1837964a1e2e6cd735e2))

## [1.33.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.33.2...control-api-v1.33.3) (2026-10-17)


### Bug Fixes

* version tool idempotency digests ([#1151](https://github.com/adea-ai/control-plane/issues/1151)) ([9629e97](https://github.com/adea-ai/control-plane/commit/9629e97ae00290876b76eac53fc46b236c4fce1e))

## [1.33.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.33.1...control-api-v1.33.2) (2026-10-17)


### Maintenance

* **tooling:** replace Control Plane Turbo with Vite+ and Bun checks ([#1170](https://github.com/adea-ai/control-plane/issues/1170)) ([84e12db](https://github.com/adea-ai/control-plane/commit/84e12dbab1b2fea2380e8747a466db9fb1449959))

## [1.33.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.33.0...control-api-v1.33.1) (2026-10-17)


### Bug Fixes

* **models:** allow child cancellation after readiness loss ([#1169](https://github.com/adea-ai/control-plane/issues/1169)) ([4f8e51f](https://github.com/adea-ai/control-plane/commit/4f8e51fc6137f96e9bc0dc37fc2f158b41fbd572))

## [1.33.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.32.3...control-api-v1.33.0) (2026-10-16)


### Features

* **models:** surface BYO lead model readiness and recheck it at every boundary ([#1159](https://github.com/adea-ai/control-plane/issues/1159)) ([83265a6](https://github.com/adea-ai/control-plane/commit/83265a66057006b0ce44f5b24959f871de84e394))
* **pi-durable:** authorized read of lead child status, input state and outcomes ([#1160](https://github.com/adea-ai/control-plane/issues/1160)) ([f96ff8f](https://github.com/adea-ai/control-plane/commit/f96ff8fb934f3ebfccdd72c749698b775ad7beb1))

## [1.32.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.32.2...control-api-v1.32.3) (2026-10-16)


### Tests

* **pi:** qualify governed child dispatch after native compaction and reopen ([#1134](https://github.com/adea-ai/control-plane/issues/1134)) ([0a453d8](https://github.com/adea-ai/control-plane/commit/0a453d83103a787bdcc6c38a6571de9188f7f559))

## [1.32.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.32.1...control-api-v1.32.2) (2026-10-14)


### Bug Fixes

* **pi-durable:** preflight retained approval tool pins ([#1124](https://github.com/adea-ai/control-plane/issues/1124)) ([128b396](https://github.com/adea-ai/control-plane/commit/128b396eca07f45185c6abf2ab476612b922968a))

## [1.32.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.32.0...control-api-v1.32.1) (2026-10-14)


### Tests

* **models:** characterize source profile scope ([#1178](https://github.com/adea-ai/control-plane/issues/1178) WIP) ([#1118](https://github.com/adea-ai/control-plane/issues/1118)) ([cc5dd03](https://github.com/adea-ai/control-plane/commit/cc5dd03f5f4a5f12f70aeefa3cb55fa9adf1e47a))

## [1.32.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.31.0...control-api-v1.32.0) (2026-10-13)


### Features

* **orchestration:** retain governed Pi child mappings and recovery proofs ([#1111](https://github.com/adea-ai/control-plane/issues/1111)) ([ba0846d](https://github.com/adea-ai/control-plane/commit/ba0846d5fd6a4919d9e80fae7cca05b60427e57c))

## [1.31.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.30.1...control-api-v1.31.0) (2026-10-12)


### Features

* coalesce child progress into bounded evidence packets ([#973](https://github.com/adea-ai/control-plane/issues/973)) ([0df9d17](https://github.com/adea-ai/control-plane/commit/0df9d17ec3b0e167e081ad8a056bc2f21a194ccd))
* **pi:** add typed retained approval-write task over the effect gate ([#939](https://github.com/adea-ai/control-plane/issues/939)) ([#1065](https://github.com/adea-ai/control-plane/issues/1065)) ([6e77203](https://github.com/adea-ai/control-plane/commit/6e772034516d31f3a7ddd0474b7c41cfc42f38a7))

## [1.30.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.30.0...control-api-v1.30.1) (2026-10-11)


### Bug Fixes

* **control-api:** pin production BYO model eligibility to the Pi catalog ([#1079](https://github.com/adea-ai/control-plane/issues/1079)) ([fceb920](https://github.com/adea-ai/control-plane/commit/fceb920bc1b7401385f6e1b23b0e4a66f365a740)), refs [#931](https://github.com/adea-ai/control-plane/issues/931) (remaining scope is open)

## [1.30.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.29.2...control-api-v1.30.0) (2026-10-10)


### Features

* m18-01-3-fence-v2-consumer ([#1066](https://github.com/adea-ai/control-plane/issues/1066)) ([c97e91d](https://github.com/adea-ai/control-plane/commit/c97e91d40570d85076796709fc8304909afe4fcb))
* **operations:** audited admission controls, stuck-job inspection, retirement gates ([#1052](https://github.com/adea-ai/control-plane/issues/1052)) ([7451dec](https://github.com/adea-ai/control-plane/commit/7451dec27386f0ebde2edebbb2e01b670ccb44c0))

## [1.29.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.29.1...control-api-v1.29.2) (2026-10-10)


### Bug Fixes

* **control-api:** settle completed lead attempt reservations exactly once ([#1068](https://github.com/adea-ai/control-plane/issues/1068)) ([2036405](https://github.com/adea-ai/control-plane/commit/2036405a90161ac23d49fb2bbced9bb640a27031))

## [1.29.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.29.0...control-api-v1.29.1) (2026-10-10)


### Tests

* **control-api:** prove persisted approvals survive physical restart ([b1b1667](https://github.com/adea-ai/control-plane/commit/b1b16670a7e081127aec31d039293176f2567dff))
* **control-api:** prove persisted approvals survive physical restart ([#932](https://github.com/adea-ai/control-plane/issues/932)) ([#1062](https://github.com/adea-ai/control-plane/issues/1062)) ([b1b1667](https://github.com/adea-ai/control-plane/commit/b1b16670a7e081127aec31d039293176f2567dff))
* **pi-durable:** register secret canaries for journal and lead-preparation sinks ([#1059](https://github.com/adea-ai/control-plane/issues/1059)) ([b5bec50](https://github.com/adea-ai/control-plane/commit/b5bec5075ef0fa0e99f3e368961479883a5f5842))

## [1.29.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.28.0...control-api-v1.29.0) (2026-10-10)


### Features

* issue-932-management-current-authority ([#1043](https://github.com/adea-ai/control-plane/issues/1043)) ([3118a7c](https://github.com/adea-ai/control-plane/commit/3118a7c9f5d177a3fdce2de8ced7fbf353d91e43))


### Tests

* **models:** qualify confirmed funding at inference boundaries ([#970](https://github.com/adea-ai/control-plane/issues/970)) ([5ee3dbf](https://github.com/adea-ai/control-plane/commit/5ee3dbf06f9a85bcb63ac29bdb13aecfeeac9a4a))

## [1.28.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.27.1...control-api-v1.28.0) (2026-10-09)


### Features

* **pi:** 935 cancel-intent persistence, attempt fencing, and target-bound observation ([#1045](https://github.com/adea-ai/control-plane/issues/1045)) ([1208729](https://github.com/adea-ai/control-plane/commit/12087297deac41190f52f629d70e40bdb8d50d01))

## [1.27.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.27.0...control-api-v1.27.1) (2026-10-09)


### Bug Fixes

* **pi:** fence cancellation by inference generation ([#1031](https://github.com/adea-ai/control-plane/issues/1031)) ([f735d7e](https://github.com/adea-ai/control-plane/commit/f735d7eae4f6b909c53a7bb4b6b4f8ef1769c9b7))

## [1.27.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.26.0...control-api-v1.27.0) (2026-10-09)


### Features

* add explicit Pi role model selection and proof ([#1016](https://github.com/adea-ai/control-plane/issues/1016)) ([b61426b](https://github.com/adea-ai/control-plane/commit/b61426bce2d5b29964fe13806a149c330d3d085e))
* **pi-durable:** add canonical current tool authority ([#932](https://github.com/adea-ai/control-plane/issues/932)) ([#1038](https://github.com/adea-ai/control-plane/issues/1038)) ([398a902](https://github.com/adea-ai/control-plane/commit/398a902071f94627a88f4f16384b909e7f1d224b))

## [1.26.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.25.0...control-api-v1.26.0) (2026-10-09)


### Features

* compose production Pi lead model and publication authority ([#996](https://github.com/adea-ai/control-plane/issues/996)) ([1332100](https://github.com/adea-ai/control-plane/commit/13321009f6e9d7984a8774df8818e1b775c582ea))


### Bug Fixes

* **pi:** fence continuation retention on current child journal ([#1007](https://github.com/adea-ai/control-plane/issues/1007)) ([b237e7a](https://github.com/adea-ai/control-plane/commit/b237e7a034a0687bd5f1ed7489c7225085e8b17d))


### Tests

* specify unfinished Pi child process recovery proofs ([#979](https://github.com/adea-ai/control-plane/issues/979)) ([6b82ccd](https://github.com/adea-ai/control-plane/commit/6b82ccd677e69eca14d765ac77d9d273df228d42))

## [1.25.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.24.1...control-api-v1.25.0) (2026-10-08)


### Features

* pi-child-continuation ([#981](https://github.com/adea-ai/control-plane/issues/981)) ([a9d8228](https://github.com/adea-ai/control-plane/commit/a9d8228d70ee6eb6234204c24c9b46dc2fc38d7a))

## [1.24.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.24.0...control-api-v1.24.1) (2026-10-08)


### Tests

* compose stored model selections with prepared lead host ([#983](https://github.com/adea-ai/control-plane/issues/983)) ([357f41c](https://github.com/adea-ai/control-plane/commit/357f41c32331788cf5a3d6bf05ef4044e17fb383))

## [1.24.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.23.0...control-api-v1.24.0) (2026-10-08)


### Features

* **pi-durable:** add persistent governed Node runtime and funded lead admission ([#949](https://github.com/adea-ai/control-plane/issues/949)) ([2ad205f](https://github.com/adea-ai/control-plane/commit/2ad205f783c09a0cc7e208d5c799d6c18636500a))

## [1.23.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.22.0...control-api-v1.23.0) (2026-10-08)


### Features

* **models:** retain Pi lead payer confirmation across send boundaries ([#962](https://github.com/adea-ai/control-plane/issues/962)) ([8135624](https://github.com/adea-ai/control-plane/commit/813562406f26259027154a40e8566ebbe5a797ab))

## [1.22.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.21.0...control-api-v1.22.0) (2026-10-08)


### Features

* **models:** bind current execution authority and recorded payer reads ([#957](https://github.com/adea-ai/control-plane/issues/957)) ([85449ba](https://github.com/adea-ai/control-plane/commit/85449baf3ea9c57997954246bf40a7e4d5589312))

## [1.21.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.20.0...control-api-v1.21.0) (2026-10-08)


### Features

* **execution:** add canonical workspace execution scope ([#951](https://github.com/adea-ai/control-plane/issues/951)) ([4ccc0de](https://github.com/adea-ai/control-plane/commit/4ccc0deb04cfb9cd47672b36e4a37b16e8b1e024))

## [1.20.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.19.0...control-api-v1.20.0) (2026-10-08)


### Features

* **models:** add pinned BYO model connections and selection ([#948](https://github.com/adea-ai/control-plane/issues/948)) ([465aa72](https://github.com/adea-ai/control-plane/commit/465aa72870b5dccdba8adb32b0caeb261f74518c))

## [1.19.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.18.0...control-api-v1.19.0) (2026-10-07)


### Features

* **catalog:** workspace-owned skills and profiles over the Control API ([#909](https://github.com/adea-ai/control-plane/issues/909)) ([858e975](https://github.com/adea-ai/control-plane/commit/858e975d00f4840e5a383463d0ddc70b44113933))
* **credential-vault:** durable workspace credentials over the Control API with tool-gateway leases ([#910](https://github.com/adea-ai/control-plane/issues/910)) ([5ac837d](https://github.com/adea-ai/control-plane/commit/5ac837d319441f5138d64feebc63d893d94e32fa))
* **marketplace:** get and uninstall workspace installations ([#907](https://github.com/adea-ai/control-plane/issues/907)) ([d5162db](https://github.com/adea-ai/control-plane/commit/d5162db9a2a6752103368d8fe307440e624fc83d))
* **project-state:** initialize a project's revision-0 state over the Control API ([#908](https://github.com/adea-ai/control-plane/issues/908)) ([8160a8f](https://github.com/adea-ai/control-plane/commit/8160a8f7e751d12a1e7cbd187c3ec7ff0f7f740b))


### Bug Fixes

* compose memory writes with current effect authority ([#891](https://github.com/adea-ai/control-plane/issues/891)) ([1757bc0](https://github.com/adea-ai/control-plane/commit/1757bc09c54ebd48b879e641ca1544930ffd072b))

## [1.18.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.17.3...control-api-v1.18.0) (2026-10-03)


### Features

* **local:** recover graph tool effects without duplicate work ([#858](https://github.com/adea-ai/control-plane/issues/858)) ([d1518fb](https://github.com/adea-ai/control-plane/commit/d1518fb061cce6af67a76f47a4796810cfa6fb35))

## [1.17.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.17.2...control-api-v1.17.3) (2026-10-03)


### Bug Fixes

* **marketplace:** avoid unchanged full-catalog downloads ([#853](https://github.com/adea-ai/control-plane/issues/853)) ([db7e19e](https://github.com/adea-ai/control-plane/commit/db7e19ecf8c57c9a0ceef71e08b174856a8bfb83))
* **marketplace:** revalidate unchanged catalogs without downloading the body ([db7e19e](https://github.com/adea-ai/control-plane/commit/db7e19ecf8c57c9a0ceef71e08b174856a8bfb83))

## [1.17.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.17.1...control-api-v1.17.2) (2026-10-03)


### Bug Fixes

* **testing:** preserve local budgets and forward remote timeouts ([#849](https://github.com/adea-ai/control-plane/issues/849)) ([8b564a9](https://github.com/adea-ai/control-plane/commit/8b564a9ee7535780a688f20789a34dac3573fd98))

## [1.17.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.17.0...control-api-v1.17.1) (2026-10-02)


### Maintenance

* **infra:** align production with the local-first MVP cost posture ([#839](https://github.com/adea-ai/control-plane/issues/839)) ([e8af976](https://github.com/adea-ai/control-plane/commit/e8af97608f103d1312cb907ba5819f4398e9c414))

## [1.17.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.16.5...control-api-v1.17.0) (2026-10-01)


### Features

* **graph:** add durable catalog administration and pinned declarative plans ([#803](https://github.com/adea-ai/control-plane/issues/803)) ([a7813c0](https://github.com/adea-ai/control-plane/commit/a7813c0b0c3f456e168fe06db99f15661b07a29f))

## [1.16.5](https://github.com/adea-ai/control-plane/compare/control-api-v1.16.4...control-api-v1.16.5) (2026-10-01)


### Bug Fixes

* **deps:** update external non-major dependencies ([#802](https://github.com/adea-ai/control-plane/issues/802)) ([76aafec](https://github.com/adea-ai/control-plane/commit/76aafec17902426c55e782e210d90d6e5aa7370a))

## [1.16.4](https://github.com/adea-ai/control-plane/compare/control-api-v1.16.3...control-api-v1.16.4) (2026-09-30)


### Maintenance

* **deps:** bump the bun-dependencies group with 14 updates ([#767](https://github.com/adea-ai/control-plane/issues/767)) ([d9e29ed](https://github.com/adea-ai/control-plane/commit/d9e29eda1658637a6da7fe7430ad7933e9cbb582))

## [1.16.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.16.2...control-api-v1.16.3) (2026-09-30)


### Bug Fixes

* **m11:** enforce catalog ownership and defer scheduled deletes ([#765](https://github.com/adea-ai/control-plane/issues/765)) ([7cdb1c4](https://github.com/adea-ai/control-plane/commit/7cdb1c4969a6fe8f57d59107d6906067538238dc))

## [1.16.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.16.1...control-api-v1.16.2) (2026-09-29)


### Bug Fixes

* **m11:** harden marketplace and package publishing ([#759](https://github.com/adea-ai/control-plane/issues/759)) ([96d8224](https://github.com/adea-ai/control-plane/commit/96d8224ac9ef9b2f57d544f04e5358ac617da044))

## [1.16.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.16.0...control-api-v1.16.1) (2026-09-29)


### Bug Fixes

* **marketplace:** allow distinct workspace namespaces ([#756](https://github.com/adea-ai/control-plane/issues/756)) ([36eebdb](https://github.com/adea-ai/control-plane/commit/36eebdb0b6d0f82a34313ce518e0eaf439ffed70))

## [1.16.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.15.3...control-api-v1.16.0) (2026-09-28)


### Features

* **m11:** harden retention, budgets and runtime delivery ([#743](https://github.com/adea-ai/control-plane/issues/743)) ([ea7ced3](https://github.com/adea-ai/control-plane/commit/ea7ced395a93ca7975a77f8b481235e893f33562))

## [1.15.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.15.2...control-api-v1.15.3) (2026-09-27)


### Bug Fixes

* **m11:** close approval and retention audit gaps ([#740](https://github.com/adea-ai/control-plane/issues/740)) ([58559d9](https://github.com/adea-ai/control-plane/commit/58559d9a0b4b4283396635f8b25bf633f4a87beb))

## [1.15.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.15.1...control-api-v1.15.2) (2026-09-26)


### Bug Fixes

* **marketplace:** read the latest pointer from the publication root ([#741](https://github.com/adea-ai/control-plane/issues/741)) ([ae26cc9](https://github.com/adea-ai/control-plane/commit/ae26cc982450fbbda654c94262fdc50b85c342c0))

## [1.15.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.15.0...control-api-v1.15.1) (2026-09-26)


### Bug Fixes

* **marketplace:** read the catalog from the publication branch ([#738](https://github.com/adea-ai/control-plane/issues/738)) ([755d6c2](https://github.com/adea-ai/control-plane/commit/755d6c2f0e22b929ac7c882c80738a4d7fb1dc34))

## [1.15.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.14.1...control-api-v1.15.0) (2026-09-25)


### Features

* **marketplace:** tolerate a release published before the browsing index ([#734](https://github.com/adea-ai/control-plane/issues/734)) ([fbdb396](https://github.com/adea-ai/control-plane/commit/fbdb39656cebf66a3c23f4f717ccf877dc85d74a))

## [1.14.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.14.0...control-api-v1.14.1) (2026-09-25)


### Bug Fixes

* **marketplace:** declare the browsing index in the SDK response contract ([#732](https://github.com/adea-ai/control-plane/issues/732)) ([83e3f8a](https://github.com/adea-ai/control-plane/commit/83e3f8abe53e6e305575434bcf6548a8edd8ecf4))

## [1.14.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.13.0...control-api-v1.14.0) (2026-09-25)


### Features

* **retention:** delete execution events with preserved identity ([#709](https://github.com/adea-ai/control-plane/issues/709)) ([a41dc81](https://github.com/adea-ai/control-plane/commit/a41dc8116387809e4898a39196c9a5bfa62fca6b))

## [1.13.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.12.0...control-api-v1.13.0) (2026-09-25)


### Features

* **retention:** assess the execution-events class ([#704](https://github.com/adea-ai/control-plane/issues/704)) ([98d7ac1](https://github.com/adea-ai/control-plane/commit/98d7ac16ee9b6ceeead288cb997161761cdb44f1))

## [1.12.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.11.0...control-api-v1.12.0) (2026-09-25)


### Features

* **retention:** authoritative eligibility predicate and assessment ([#702](https://github.com/adea-ai/control-plane/issues/702)) ([393b495](https://github.com/adea-ai/control-plane/commit/393b495f8d1a788402b734e9f1a7793e073eab17))

## [1.11.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.10.1...control-api-v1.11.0) (2026-09-24)


### Features

* **m11:** close the approval-gate coverage gaps on execution read paths ([#693](https://github.com/adea-ai/control-plane/issues/693)) ([6eeb9e9](https://github.com/adea-ai/control-plane/commit/6eeb9e9c39ed5670f17f859f661b4b36d3fc4514))

## [1.10.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.10.0...control-api-v1.10.1) (2026-09-24)


### Bug Fixes

* **marketplace:** accept a catalog manifest that declares extra artifacts ([#690](https://github.com/adea-ai/control-plane/issues/690)) ([ae5b172](https://github.com/adea-ai/control-plane/commit/ae5b17296cbc5b33315c22181b7741efbdf4a8b7))

## [1.10.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.9.3...control-api-v1.10.0) (2026-09-24)


### Features

* **m11:** enforce catalog approval on profile resolution (default off) ([#687](https://github.com/adea-ai/control-plane/issues/687)) ([2f13c52](https://github.com/adea-ai/control-plane/commit/2f13c52bd4a0d9bc02eeab704b0a7dc924e3352e))

## [1.9.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.9.2...control-api-v1.9.3) (2026-09-21)


### Maintenance

* **deps:** bump the npm-dependencies group with 4 updates ([#595](https://github.com/adea-ai/control-plane/issues/595)) ([d754692](https://github.com/adea-ai/control-plane/commit/d7546929d62c1656047e53af046e0e86bfbc7244))

## [1.9.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.9.1...control-api-v1.9.2) (2026-09-21)


### Bug Fixes

* **type-safety:** strengthen the context-authoring guard ([#619](https://github.com/adea-ai/control-plane/issues/619)) ([279b59f](https://github.com/adea-ai/control-plane/commit/279b59ff9b77d0c2c8296f32591af7b76cdb7c90))
* **type-safety:** strengthen the context-authoring guard in execution validation ([279b59f](https://github.com/adea-ai/control-plane/commit/279b59ff9b77d0c2c8296f32591af7b76cdb7c90))

## [1.9.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.9.0...control-api-v1.9.1) (2026-09-20)


### Bug Fixes

* replace locale-dependent sort comparators with code-point ordering ([#614](https://github.com/adea-ai/control-plane/issues/614)) ([46897cd](https://github.com/adea-ai/control-plane/commit/46897cd99faeda65c1659c312d80ded809dc61d5))

## [1.9.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.8.3...control-api-v1.9.0) (2026-09-20)


### Features

* artifacts-retention ([#559](https://github.com/adea-ai/control-plane/issues/559)) ([8fb56b9](https://github.com/adea-ai/control-plane/commit/8fb56b9d4aab0729bad5b1e3da3cfdbf817836b9))
* **local:** SQLite-backed durable execution without Restate + persistence-profile conformance ([#569](https://github.com/adea-ai/control-plane/issues/569)) ([a6ceaf0](https://github.com/adea-ai/control-plane/commit/a6ceaf0ac5d7544ae5196e58995c9a4d81971c49))


### Bug Fixes

* **control-api:** wire database readiness and the retention sweep into the cloud composition ([#566](https://github.com/adea-ai/control-plane/issues/566)) ([a692613](https://github.com/adea-ai/control-plane/commit/a692613ffc5c3a45f4d24c2a23b2fdb3f46a537d))


### Tests

* m194-artifact-retention ([#561](https://github.com/adea-ai/control-plane/issues/561)) ([5ffc778](https://github.com/adea-ai/control-plane/commit/5ffc778642aa47733b884764ae54b2bb56a68689))
* m194-rpo-rto ([#539](https://github.com/adea-ai/control-plane/issues/539)) ([9cf1598](https://github.com/adea-ai/control-plane/commit/9cf15982a25f8d7f95c1d99dbae1e989b637989e))


### Maintenance

* **deps:** bump the npm-dependencies group across 1 directory with 9 updates ([#567](https://github.com/adea-ai/control-plane/issues/567)) ([8008fd4](https://github.com/adea-ai/control-plane/commit/8008fd4c063735e362e565d637b3e33367e97e0e))
* toolchain-alignment ([#564](https://github.com/adea-ai/control-plane/issues/564)) ([d30ea64](https://github.com/adea-ai/control-plane/commit/d30ea64356f0aa49d654db0cc69d7618df3ef5f8))

## [1.8.3](https://github.com/adea-ai/control-plane/compare/control-api-v1.8.2...control-api-v1.8.3) (2026-09-17)


### Documentation

* skill-maintenance-cadence ([#545](https://github.com/adea-ai/control-plane/issues/545)) ([8cd335e](https://github.com/adea-ai/control-plane/commit/8cd335e23445325f9fdacf009776828a1ade2238))

## [1.8.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.8.1...control-api-v1.8.2) (2026-09-15)


### Bug Fixes

* **control-api:** cap marketplace artifact downloads in flight ([#515](https://github.com/adea-ai/control-plane/issues/515)) ([b36ed4c](https://github.com/adea-ai/control-plane/commit/b36ed4c2febe680bd2327ae793a0f80d399d6203))

## [1.8.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.8.0...control-api-v1.8.1) (2026-09-15)


### Bug Fixes

* marketplace-artifact-cap ([#507](https://github.com/adea-ai/control-plane/issues/507)) ([788a54a](https://github.com/adea-ai/control-plane/commit/788a54af5f4c892a8e8719c1f8358d946f70a89c))

## [1.8.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.7.0...control-api-v1.8.0) (2026-09-12)


### Features

* integrate M11 provider authoring and native build fixes ([#470](https://github.com/adea-ai/control-plane/issues/470)) ([b195736](https://github.com/adea-ai/control-plane/commit/b195736c2fa5154b43dd82deeaa7fc1c26326f71))

## [1.7.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.6.2...control-api-v1.7.0) (2026-09-12)


### Features

* local-profile-marketplace-registry ([#448](https://github.com/adea-ai/control-plane/issues/448)) ([87bb3c1](https://github.com/adea-ai/control-plane/commit/87bb3c159626cddfeb36f0024abe64b1e1f3428f))

## [1.6.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.6.1...control-api-v1.6.2) (2026-09-10)


### Bug Fixes

* eliminate lint warnings and stabilize websocket replacement test ([#444](https://github.com/adea-ai/control-plane/issues/444)) ([c3157a6](https://github.com/adea-ai/control-plane/commit/c3157a6d6f6fe11881958786c817a6ea9032063d))

## [1.6.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.6.0...control-api-v1.6.1) (2026-09-10)


### Maintenance

* roll up dependencies and Code Foundry v1.28.6 ([#442](https://github.com/adea-ai/control-plane/issues/442)) ([09a245a](https://github.com/adea-ai/control-plane/commit/09a245abf2ed325d9dfc7f900851389745c83e3e))

## [1.6.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.5.0...control-api-v1.6.0) (2026-09-09)


### Features

* add marketplace agent plugin plans ([0441004](https://github.com/adea-ai/control-plane/commit/0441004f34fd4b61b4fa63acd261bdbab9432856))
* add marketplace Agent Plugins plans ([#440](https://github.com/adea-ai/control-plane/issues/440)) ([0441004](https://github.com/adea-ai/control-plane/commit/0441004f34fd4b61b4fa63acd261bdbab9432856))

## [1.5.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.4.0...control-api-v1.5.0) (2026-09-08)


### Features

* **acp:** integrate native v1 process transport ([bf41225](https://github.com/adea-ai/control-plane/commit/bf412255869b4312947309995b8ae18ff11a0b86))

## [1.4.0](https://github.com/adea-ai/control-plane/compare/control-api-v1.3.2...control-api-v1.4.0) (2026-09-08)


### Features

* **m11:** integrate standalone runtime and audit candidate ([#412](https://github.com/adea-ai/control-plane/issues/412)) ([a76f274](https://github.com/adea-ai/control-plane/commit/a76f27453e558525a05089e3c88085153a63a528))
* **packages:** publish six stable packages under [@adea-ai](https://github.com/adea-ai) on npm ([#398](https://github.com/adea-ai/control-plane/issues/398)) ([973a8df](https://github.com/adea-ai/control-plane/commit/973a8df4eb4957f1b9ffa92760aff6584cc6605d))


### Bug Fixes

* **m11:** clear retained Railway sources and verify staging standby ([#417](https://github.com/adea-ai/control-plane/issues/417)) ([a91315e](https://github.com/adea-ai/control-plane/commit/a91315e6cae50704dbf8dc2faec178c269996237))

## [1.3.2](https://github.com/adea-ai/control-plane/compare/control-api-v1.3.1...control-api-v1.3.2) (2026-09-07)


### Maintenance

* **ci:** upgrade code-foundry runtime to v1.3.1 and migrate to oxlint/oxfmt ([#384](https://github.com/adea-ai/control-plane/issues/384)) ([fc4d310](https://github.com/adea-ai/control-plane/commit/fc4d310056b2e6824907f8cb80d3d4f8fa5deb95))

## [1.3.1](https://github.com/adea-ai/control-plane/compare/control-api-v1.3.0...control-api-v1.3.1) (2026-09-05)


### Maintenance

* review-policy-gate ([#357](https://github.com/adea-ai/control-plane/issues/357)) ([d152f2c](https://github.com/adea-ai/control-plane/commit/d152f2c1a3159a5fd4b194eeb84254d474f3d41d))

## [1.3.0](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.2.1...control-api-v1.3.0) (2026-08-30)


### Features

* **portability:** compose the local control API ([#309](https://github.com/0xPlayerOne/control-plane/pull/309)) ([4a27c47](https://github.com/0xPlayerOne/control-plane/commit/4a27c4746ca3ca1ab248871dd4bef8713d77ec36))
* **hosted:** add private hosted authentication ([#311](https://github.com/0xPlayerOne/control-plane/pull/311)) ([2a4de56](https://github.com/0xPlayerOne/control-plane/commit/2a4de56d6e352155cf42c0b44302241f1b92442a))
* **operations:** report dependency-aware readiness ([#317](https://github.com/0xPlayerOne/control-plane/pull/317)) ([af22ead](https://github.com/0xPlayerOne/control-plane/commit/af22eade12e70d5de982f385e0747862f5b39c7c))

## [1.2.1](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.2.0...control-api-v1.2.1) (2026-08-29)


### Bug Fixes

* **ci:** adopt Code Foundry v0.39.3 ([#288](https://github.com/0xPlayerOne/control-plane/issues/288)) ([43baeb9](https://github.com/0xPlayerOne/control-plane/commit/43baeb9049daa76f422d83ce611bd39d4636c6a6))

## [1.2.0](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.1.2...control-api-v1.2.0) (2026-08-29)


### Features

* **control-api:** accept cloud executions ([242f599](https://github.com/0xPlayerOne/control-plane/commit/242f59960b24b7355f88bf1eda6343f14ed5c5f0))
* **control-api:** compose managed cloud startup ([a99ef72](https://github.com/0xPlayerOne/control-plane/commit/a99ef727554463834ee10c7651158da6bc7ce848))
* **control-api:** validate execution requests ([3ab0636](https://github.com/0xPlayerOne/control-plane/commit/3ab0636aeba30f15676fd09c85ca079b25130486))
* **control-api:** verify signed service credentials ([585777d](https://github.com/0xPlayerOne/control-plane/commit/585777d32f7c8f44c90053236175e35b21c1eef5))
* harden M9 production foundations ([#185](https://github.com/0xPlayerOne/control-plane/issues/185)) ([453d4c8](https://github.com/0xPlayerOne/control-plane/commit/453d4c8afb63ad8c78c00537f3858a4a75637fce))


### Bug Fixes

* **operations:** apply cloud policy defaults at boundaries ([#231](https://github.com/0xPlayerOne/control-plane/issues/231)) ([d95ac2f](https://github.com/0xPlayerOne/control-plane/commit/d95ac2f030a1f791676845b7e15e75d6edcc24e4))

## [1.1.2](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.1.1...control-api-v1.1.2) (2026-08-25)


### Maintenance

* **typescript:** strengthen compiler checks ([#151](https://github.com/0xPlayerOne/control-plane/issues/151)) ([b58dfba](https://github.com/0xPlayerOne/control-plane/commit/b58dfba7d2aa6f4eaf783d89cb8899eb6cffc636))

## [1.1.1](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.1.0...control-api-v1.1.1) (2026-08-24)


### Bug Fixes

* **api:** wire runtime discovery at startup ([#134](https://github.com/0xPlayerOne/control-plane/issues/134)) ([997cb29](https://github.com/0xPlayerOne/control-plane/commit/997cb297add20461a6fa90852da935783192fbeb))

## [1.1.0](https://github.com/0xPlayerOne/control-plane/compare/control-api-v1.0.0...control-api-v1.1.0) (2026-08-24)


### Features

* **runtime:** expose Agent HQ discovery models ([#123](https://github.com/0xPlayerOne/control-plane/issues/123)) ([cf43141](https://github.com/0xPlayerOne/control-plane/commit/cf43141f18d82fb3bd5466e47f1df8606b1d1fa1))

## 1.0.0 (2026-08-24)


### Features

* add service configuration bootstrap ([3d7364a](https://github.com/0xPlayerOne/control-plane/commit/3d7364ac54a68744f8a46407861489014bb8e2a3))
* add telemetry foundation ([#80](https://github.com/0xPlayerOne/control-plane/issues/80)) ([6ca188e](https://github.com/0xPlayerOne/control-plane/commit/6ca188e1f26cd32cfd05dea005e067f8eff27938))
* bootstrap the platform monorepo ([3a745cd](https://github.com/0xPlayerOne/control-plane/commit/3a745cdf3cdaee9c57677039acdb057e3c528f3d))
* enforce Agent HQ service authentication ([#89](https://github.com/0xPlayerOne/control-plane/issues/89)) ([09c0554](https://github.com/0xPlayerOne/control-plane/commit/09c0554f832e4bb40229ed0366274ea2b78721fe))
* scaffold NestJS Fastify Control API ([e99cdde](https://github.com/0xPlayerOne/control-plane/commit/e99cdded89f5c3dad6d6ff0b6d45c06a8b2bee73)), closes [#4](https://github.com/0xPlayerOne/control-plane/issues/4)


### Tests

* add shared foundation harness ([#79](https://github.com/0xPlayerOne/control-plane/issues/79)) ([96053ed](https://github.com/0xPlayerOne/control-plane/commit/96053ed7e9a38a3f391168b12906a7165f335fb3))
* prove M2 core-domain acceptance ([#103](https://github.com/0xPlayerOne/control-plane/issues/103)) ([eada793](https://github.com/0xPlayerOne/control-plane/commit/eada793f49e91ba4179e126b592bcb40b77ee88b)), closes [#19](https://github.com/0xPlayerOne/control-plane/issues/19)


### Maintenance

* **deps:** apply compatible npm dependency updates ([#102](https://github.com/0xPlayerOne/control-plane/issues/102)) ([eaf3e48](https://github.com/0xPlayerOne/control-plane/commit/eaf3e48f5fe6c85c79e6d83874df8af24f079f5c))
