param([string]$photoPath = "C:\Users\sareh\Downloads\IMG_20250320_052311.jpg")
$ProgressPreference = "SilentlyContinue"
$env:PGPASSWORD = "change_me_local"
$base = "http://localhost:4000/api/v1"
$GE = "8af616a7-0dcc-4c90-910b-c3732cb66784"
$rows = @()

function Call($method, $url, $headers = @{}, $body = $null) {
  try {
    $r = Invoke-WebRequest -Uri $url -Method $method -Headers $headers -ContentType "application/json" -Body $body -UseBasicParsing
    return @{ status = [int]$r.StatusCode; text = "$($r.Content)" }
  } catch {
    return @{ status = [int]$_.Exception.Response.StatusCode.value__; text = "$($_.ErrorDetails.Message)" }
  }
}

function Check($name, $res, [int]$expect, $contains = "") {
  $ok = ($res.status -eq $expect) -and ($contains -eq "" -or $res.text -like "*$contains*")
  $script:rows += [pscustomobject]@{ Check = $name; Expected = $expect; Got = $res.status; Pass = $ok }
  Write-Host ("{0,-40} {1}" -f $name, $(if ($ok) { "PASS" } else { "FAIL -> $($res.text)" }))
}

# 1 Catalogue
Check "countries list" (Call GET "$base/countries") 200 "GE"
Check "product for GE" (Call GET "$base/products/GE") 200 "5500"
Check "visa check IN->GE" (Call GET "$base/visa-check?passport=IN&destination=GE") 200 "visa_required"
Check "visa check unknown country" (Call GET "$base/visa-check?passport=XX&destination=GE") 404 "Country not found"
Check "unknown route" (Call GET "$base/nothing-here") 404 "not_found"

# 2 Basic details (gender and marital status required), checkout, payment
$body = @{ destinationIso2="GE"; passportIso2="IN"; travelDate="2026-12-20"; contactEmail="test@example.com"; contactPhone="+911234567890"; applicants=@(@{ fullName="Flow Test"; gender="female"; maritalStatus="married" }) } | ConvertTo-Json -Depth 4
$req = Call POST "$base/requests" @{} $body
Check "create pending checkout" $req 201 "PC-"
$reqId = ($req.text | ConvertFrom-Json).id
$co = Call POST "$base/requests/$reqId/checkout"
Check "checkout returns payment url" $co 200 "session_id=dummy_"
$sid = (($co.text | ConvertFrom-Json).url -split "session_id=")[1]
$hook = Call POST "$base/webhooks/dummy-payment" @{} (@{ sessionId = $sid } | ConvertTo-Json)
Check "webhook creates order" $hook 200 "VISA-"
$orderNo = ($hook.text | ConvertFrom-Json).orderNumber
Check "verify reports paid" (Call GET "$base/payments/verify?session_id=$sid") 200 '"paid":true'

# 3 Applicant id (looked up by order number) and token
$idRow = & psql -U legwork -h localhost -d legwork -c "SELECT a.id FROM applicants a JOIN orders o ON o.id = a.order_id WHERE o.order_number = '$orderNo';" 2>$null
$applicantId = ($idRow | Select-String -Pattern "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").Matches[0].Value
$token = (node -e "const {issueTestToken}=require('./dist/modules/applications/tokens.js'); console.log(issueTestToken('$applicantId'))").Trim()
$h = @{ "x-applicant-token" = $token }
@"
INSERT INTO form_fields (visa_product_id, form_version, step, group_key, field_key, label, field_type, required, options, sort_order, visible_if) VALUES
('$GE', 1, 'full', 'travel', 'first_visit', 'Is this your first time visiting?', 'radio', true, '["Yes","No"]', 10, NULL),
('$GE', 1, 'full', 'travel', 'last_visit_date', 'Last visit date', 'date', false, '[]', 20, '{"field":"first_visit","equals":"No"}'),
('$GE', 1, 'full', 'travel', 'passport_number', 'Passport number', 'text', true, '[]', 30, NULL)
ON CONFLICT DO NOTHING;
"@ | Set-Content -Path insert_flow.sql -Encoding ascii
& psql -U legwork -h localhost -d legwork -q -f insert_flow.sql 2>$null
Remove-Item insert_flow.sql

# 4 Visible questions
Check "form with no answers" (Call GET "$base/visaProducts/$GE/form") 200 "first_visit"
$no = [uri]::EscapeDataString('{"first_visit":"No"}')
Check "form: first visit No shows follow-up" (Call GET "$base/visaProducts/$GE/form?answers=$no") 200 "last_visit_date"
$bad = [uri]::EscapeDataString('not json')
Check "form: malformed answers" (Call GET "$base/visaProducts/$GE/form?answers=$bad") 400 "valid JSON"

# 5 Save answers
$ans = @{ answers = @{ first_visit="No"; last_visit_date="2024-05-01"; passport_number="568780197" } } | ConvertTo-Json -Depth 4
Check "save answers" (Call PUT "$base/applicants/$applicantId/answers" $h $ans) 200 "savedFields"
Check "save with wrong token" (Call PUT "$base/applicants/$applicantId/answers" @{ "x-applicant-token" = "wrong" } $ans) 401 "Invalid access token"
$unk = @{ answers = @{ no_such_field="x" } } | ConvertTo-Json -Depth 4
Check "save unknown field" (Call PUT "$base/applicants/$applicantId/answers" $h $unk) 400 "Unknown field"
$hid = @{ answers = @{ first_visit="Yes"; last_visit_date="2024-05-01" } } | ConvertTo-Json -Depth 4
Check "save hidden field" (Call PUT "$base/applicants/$applicantId/answers" $h $hid) 400 "Field not visible"

# 6 Submit before documents
Check "submit refused: no documents" (Call POST "$base/applicants/$applicantId/submit" $h) 400 "Missing required documents"

# 7 Upload the three required documents
foreach ($t in @("applicant_photo","passport_scan","return_ticket")) {
  $out = curl.exe -s -X POST "$base/applicants/$applicantId/documents" -H "x-applicant-token: $token" -F "documentType=$t" -F "file=@$photoPath;type=image/jpeg"
  $pass = ("$out" -like "*documentId*")
  $rows += [pscustomobject]@{ Check = "upload $t"; Expected = "documentId"; Got = $(if ($pass) { "201" } else { "-" }); Pass = $pass }
  Write-Host ("{0,-40} {1}" -f "upload $t", $(if ($pass) { "PASS" } else { "FAIL -> $out" }))
}

# 8 Submit after uploads (Step 2: uploaded documents count)
Check "submit after uploads" (Call POST "$base/applicants/$applicantId/submit" $h) 200 "complete"

$rows | Format-Table -AutoSize
"Passed: $(($rows | Where-Object Pass).Count) of $($rows.Count)"