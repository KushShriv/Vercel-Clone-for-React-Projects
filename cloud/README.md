# Optional AWS public hosting — experimental

This is an **unverified implementation**, not a hosted service. It has not been tested in an AWS account. Review the template, IAM permissions, network access, costs and teardown steps before creating resources or publishing. Do not use this path for sensitive material. The bucket and CloudFront distribution remain active, publicly reachable and potentially billable after your computer or local service stops. Publishing and deleting content are explicit commands you run yourself.

The target is a private S3 bucket accessed by a public HTTPS CloudFront distribution using origin access control. Each local build uses an independent, immutable `deployments/<job-id>/` prefix. The CloudFront function routes extensionless SPA paths to that prefix's `index.html`. File paths with no extension are treated as routes. The default CloudFront domain supplies HTTPS. For a custom domain, configure a CloudFront alternate domain name, a validated ACM certificate in `us-east-1`, and DNS as described in [AWS's custom-domain instructions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html); this template does not configure those resources.

## Setup, only after review

Install AWS CLI v2 and use a user-managed temporary credential chain or EC2 instance role. Credentials must not be placed in source files, the dashboard or the build container. Choose a region, review [AWS pricing](https://aws.amazon.com/cloudfront/pricing/) and create the stack yourself:

```sh
aws cloudformation deploy --template-file cloud/hosting.yaml --stack-name local-deploy-site
aws cloudformation describe-stacks --stack-name local-deploy-site --query 'Stacks[0].Outputs'
```

Wait for the distribution to reach `Deployed`. Record its `Bucket` and `DistributionId` outputs. The script checks that the distribution uses that bucket as its default private S3 origin, with `/deployments` as the origin path. This check does not independently verify the distribution's complete configuration, function, bucket policy, ownership or domain. Check those in your account. The template uses [CloudFront origin access control](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), a [viewer-request function](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cloudfront-function.html), and AWS's [managed CachingOptimized policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html).

Use a dedicated principal for the publisher. Give it only these permissions for the specific resources, and test them in your own account:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on `arn:aws:s3:::BUCKET/deployments/*`; restrict further to one deployment prefix when possible.
- `s3:ListBucket` on `arn:aws:s3:::BUCKET` with an `s3:prefix` condition for `deployments/*`, needed by recursive deletion.
- `cloudfront:GetDistribution`, `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` on the specific distribution ARN.

Do not give these credentials to the worker. Creating the CloudFormation stack requires separate administrative permissions. Consult [AWS temporary credentials](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_temp.html) and [S3 checksum documentation](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html).

## Publish a ready local job

The local service must still be running. Find the ready job ID in its local dashboard. The artifact export is authenticated by the local pairing token; it never sends AWS credentials to the dashboard or worker. In a terminal, enter the pairing token without echoing it, then run the command below. The token passes through standard input, not the command line:

```sh
read -rs PAIRING_TOKEN
printf '%s' "$PAIRING_TOKEN" | node cloud/publish.mjs publish JOB_ID BUCKET DISTRIBUTION_ID
unset PAIRING_TOKEN
```

The publisher validates the artifact, checks the configured distribution, reserves a unique prefix, uploads each file with a SHA-256 checksum, checks each stored checksum and verifies the public HTTPS index before printing the URL. It uploads the index last. A failed publish can leave a partial prefix; do not reuse the ID. Use the delete command below to remove it. Uploads make files public as they complete, before the final verification. This is not an atomic publish.

Only output built by this local service with that job ID as its Vite base is supported. The publisher rejects an index that does not contain the expected base path. Preview restrictions do not carry over to the public site: published JavaScript runs in visitors' browsers and can make network requests.

## Rollback, deletion and teardown

Previous prefixes remain available until deleted. To roll back, share the URL of the earlier verified prefix; there is no stable alias or automatic redirect. Keep a record of verified URLs. To delete one prefix and wait for its CDN invalidation:

```sh
node cloud/publish.mjs delete JOB_ID BUCKET DISTRIBUTION_ID
```

This deletes the exact prefix and requests a CloudFront invalidation. It does not remove content that visitors or other caches have already stored. Deletion is irreversible. A failed delete or invalidation needs investigation and a retry. For teardown, delete **all** prefixes and confirm the bucket is empty, then delete the CloudFormation stack and wait for deletion to finish. Check the AWS console for remaining buckets, distributions, DNS records and certificates; the custom domain resources above are not managed by this stack. Do not delete unrelated bucket contents or infrastructure.

There is no automatic retention policy, custom-domain setup, hosted backend, IAM provisioning, live-account test or cost estimate. The publisher does not report a public URL until all publish checks succeed. Browser, routing, IAM, cleanup, TLS and cost behavior require real-account verification before relying on this option.
