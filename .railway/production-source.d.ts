import { github } from 'railway/iac'

export type SourceOptions = {
  production: boolean
  repository: string
  branch: string
  productionImage?: string | undefined
}

export declare function resolveApplicationSource(options: SourceOptions): ReturnType<typeof github>
