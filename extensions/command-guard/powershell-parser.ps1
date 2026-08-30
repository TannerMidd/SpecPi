$ErrorActionPreference = 'Stop'
$maxInput = 131072
$maxTokens = 4096
$maxCommands = 128
$text = [Console]::In.ReadToEnd()
$edition = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'Desktop' } else { 'Core' }
function Clip([string]$s, [int]$n = 512) { if ($null -eq $s) { return $null }; if ($s.Length -gt $n) { return $s.Substring(0, $n) }; return $s }
function Pos($e) { if ($null -eq $e) { return @{ start = 0; end = 0 } }; return @{ start = [int]$e.StartOffset; end = [int]$e.EndOffset } }
function DynamicNode($n) { return ($n -is [System.Management.Automation.Language.ScriptBlockExpressionAst] -or $n -is [System.Management.Automation.Language.SubExpressionAst] -or $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] -or $n -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) }
try {
  if ($text.Length -gt $maxInput) { throw 'input limit exceeded' }
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
  $errorItems = @($errors | Select-Object -First 32 | ForEach-Object { $p = Pos $_.Extent; @{ errorId = Clip $_.ErrorId 96; start = $p.start; end = $p.end; message = Clip $_.Message 256 } })
  $commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
    $command = $_; $p = Pos $command.Extent; $name = $command.GetCommandName()
    $pipeline = $command.Parent; while ($null -ne $pipeline -and -not ($pipeline -is [System.Management.Automation.Language.PipelineAst])) { $pipeline = $pipeline.Parent }
    $pipelineStart = if ($null -ne $pipeline) { [int]$pipeline.Extent.StartOffset } else { $null }
    $elements = @($command.CommandElements | Select-Object -First 256 | ForEach-Object {
      $ep = Pos $_.Extent; $literal = $null
      $literalTruncated = $false; $elementDynamic = [bool](DynamicNode $_)
      if ($_ -is [System.Management.Automation.Language.CommandParameterAst]) {
        $rawLiteral = '-' + $_.ParameterName
        if ($null -ne $_.Argument) {
          if ($_.Argument -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $_.Argument -is [System.Management.Automation.Language.ConstantExpressionAst]) { $rawLiteral += ':' + [string]$_.Argument.Value }
          else { $elementDynamic = $true }
        }
        $literalTruncated = $rawLiteral.Length -gt 4096; $literal = Clip $rawLiteral 4096
      } elseif ($_ -is [System.Management.Automation.Language.StringConstantExpressionAst] -or $_ -is [System.Management.Automation.Language.ConstantExpressionAst]) { $rawLiteral = [string]$_.Value; $literalTruncated = $rawLiteral.Length -gt 4096; $literal = Clip $rawLiteral 4096 }
      @{ astType = $_.GetType().Name; start = $ep.start; end = $ep.end; literal = $literal; literalTruncated = $literalTruncated; dynamic = $elementDynamic }
    })
    $reds = @($command.Redirections | Select-Object -First 128 | ForEach-Object { $rp = Pos $_.Extent; $target = $null; $targetTruncated = $false; if ($_.Location -is [System.Management.Automation.Language.StringConstantExpressionAst]) { $rawTarget = [string]$_.Location.Value; $target = Clip $rawTarget 4096; $targetTruncated = $rawTarget.Length -gt 4096 }; @{ astType = $_.GetType().Name; start = $rp.start; end = $rp.end; targetLiteral = $target; targetTruncated = [bool]$targetTruncated; dynamic = $null -eq $target } })
    @{ start = $p.start; end = $p.end; pipelineStart = $pipelineStart; commandName = $name; invocationOperator = ([string]$command.InvocationOperator); elements = $elements; elementsTruncated = ($command.CommandElements.Count -gt 256); redirections = $reds; redirectionsTruncated = ($command.Redirections.Count -gt 128) }
  })
  $dynamic = @($ast.FindAll({ param($n) DynamicNode $n }, $true) | Select-Object -First 256 | ForEach-Object { $p = Pos $_.Extent; @{ kind = $_.GetType().Name; start = $p.start; end = $p.end } })
  $stop = @($tokens | Where-Object { ([string]$_.Kind -eq 'StopParsing') -or $_.Text -eq '--%' } | Select-Object -First 128 | ForEach-Object { $p = Pos $_.Extent; @{ start = $p.start; end = $p.end } })
  $limit = $null; if ($tokens.Count -gt $maxTokens) { $limit = 'tokens' }; if ($commands.Count -gt $maxCommands) { $limit = 'commands' }; if (@($commands | Where-Object { $_.elementsTruncated }).Count -gt 0) { $limit = 'elements' }; if (@($commands | Where-Object { $_.redirectionsTruncated }).Count -gt 0) { $limit = 'redirections' }
  $out = @{ schema = 1; ok = ($errorItems.Count -eq 0 -and $null -eq $limit); parser = @{ edition = $edition; version = [string]$PSVersionTable.PSVersion }; tokenCount = [int]$tokens.Count; errors = $errorItems; commands = @($commands | Select-Object -First $maxCommands); dynamicConstructs = $dynamic; stopParsingTokens = $stop }
  if ($null -ne $limit) { $out.limitExceeded = $limit }
  [Console]::Out.Write((ConvertTo-Json $out -Compress -Depth 16))
} catch {
  $out = @{ schema = 1; ok = $false; parser = @{ edition = $edition; version = [string]$PSVersionTable.PSVersion }; tokenCount = 0; errors = @(@{ errorId = 'GUARD_HELPER_FAILURE'; start = 0; end = 0; message = (Clip $_.Exception.Message 256) }); commands = @(); dynamicConstructs = @(); stopParsingTokens = @() }
  [Console]::Out.Write((ConvertTo-Json $out -Compress -Depth 16))
  exit 2
}
