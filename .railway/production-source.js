import { github, image } from 'railway/iac'

const productionImagePattern = /^ghcr\.io\/adea-ai\/control-plane-control-api@sha256:[0-9a-f]{64}$/

export function resolveApplicationSource({ production, repository, branch, productionImage }) {
  if (!production) return github(repository, { branch })

  if (typeof productionImage !== 'string' || !productionImagePattern.test(productionImage)) {
    throw new Error(
      'Production authoring requires CONTROL_PLANE_PRODUCTION_IMAGE to be the immutable control-api GHCR digest.'
    )
  }

  return image(productionImage)
}
